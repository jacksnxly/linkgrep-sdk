import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import { parseErrorResponse, RateLimitError } from "../http/errors.js";
import { withRetry } from "../http/retry.js";

// vitest.config.ts:8-12 documents that all SDK test files share a single
// MSW setupServer instance (msw-server.ts), with lifecycle hooks owned by
// setup.ts. Spinning up a second setupServer here would stack interceptors
// and silently bypass the global `onUnhandledRequest: "error"` safety net.
// MSW docs (https://mswjs.io/docs/integrations/node) recommend exactly this
// shared-instance pattern.
const BASE = "http://api.linkgrep.test";

// Regression for keryx #I3a: Retry-After in HTTP-date format must be parsed,
// not silently dropped. Per RFC 9110 §10.2.3:  Retry-After = HTTP-date / delay-seconds
describe("parseErrorResponse — Retry-After dual format (#I3a)", () => {
  it("parses HTTP-date Retry-After into a seconds value", async () => {
    const sevenSecondsHence = new Date(Date.now() + 7000).toUTCString();
    server.use(
      http.post(`${BASE}/probe`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "slow", doc_url: "" } },
          { status: 429, headers: { "retry-after": sevenSecondsHence } },
        ),
      ),
    );
    const res = await fetch(`${BASE}/probe`, { method: "POST" });
    const body = await res.json();
    const err = parseErrorResponse(res, body);
    expect(err).toBeInstanceOf(RateLimitError);
    const r = (err as RateLimitError).retryAfter;
    expect(r, "HTTP-date parsed").toBeGreaterThanOrEqual(5);
    expect(r, "HTTP-date parsed").toBeLessThanOrEqual(8);
  });

  it("still parses delta-seconds Retry-After as a number", async () => {
    server.use(
      http.post(`${BASE}/probe`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "slow", doc_url: "" } },
          { status: 429, headers: { "retry-after": "13" } },
        ),
      ),
    );
    const res = await fetch(`${BASE}/probe`, { method: "POST" });
    const err = parseErrorResponse(res, await res.json());
    expect((err as RateLimitError).retryAfter).toBe(13);
  });

  it("ignores garbage Retry-After values", async () => {
    server.use(
      http.post(`${BASE}/probe`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "slow", doc_url: "" } },
          { status: 429, headers: { "retry-after": "bogus" } },
        ),
      ),
    );
    const res = await fetch(`${BASE}/probe`, { method: "POST" });
    const err = parseErrorResponse(res, await res.json());
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });

  // Regression for keryx batch-2 #I2: RFC 9110 §10.2.3 defines
  //   delay-seconds = 1*DIGIT (non-negative base-10 integer).
  // Previously `Number(raw)` + Number.isFinite accepted negatives, decimals,
  // hex, scientific notation, and whitespace-only strings (coerced to 0).
  // Each of these must now return undefined so the value cannot leak through
  // the public RateLimitError.retryAfter as a misleading number.
  it.each([
    ["-5",   "negative integer"],
    ["13.5", "decimal"],
    ["0x10", "hexadecimal literal"],
    ["1e3",  "scientific notation"],
    ["   ",  "whitespace-only"],
    ["+12",  "explicit plus sign"],
  ])("rejects %s (%s) per RFC 9110 §10.2.3", async (header) => {
    server.use(
      http.post(`${BASE}/probe`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "slow", doc_url: "" } },
          { status: 429, headers: { "retry-after": header } },
        ),
      ),
    );
    const res = await fetch(`${BASE}/probe`, { method: "POST" });
    const err = parseErrorResponse(res, await res.json());
    expect((err as RateLimitError).retryAfter).toBeUndefined();
  });
});

// Regression for keryx #I3b: Retry-After larger than the SDK's cap must throw
// the RateLimitError immediately without retrying. The caller still has the
// raw value on err.retryAfter for its own scheduling.
describe("withRetry — Retry-After above cap (#I3b)", () => {
  it("throws RateLimitError without retrying when retryAfter exceeds cap", async () => {
    const fn = vi.fn(async () => {
      throw new RateLimitError({
        status: 429,
        code: "rate_limited",
        message: "long wait",
        raw: null,
        headers: new Headers(),
        retryAfter: 600, // 10 min, way over the 60s cap
      });
    });
    // No fake timers needed: the cap path must throw without sleeping.
    await expect(withRetry(fn, 3)).rejects.toBeInstanceOf(RateLimitError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Regression for keryx batch-2 #I11: at the cap boundary (retryAfter=60s),
  // the strict `>` check lets the loop proceed, and `floorJitter` (up to 1000ms
  // worst-case) could push the actual sleep to ~61_000ms — breaching the
  // documented cap. The post-jitter sleep MUST be clamped to MAX_RETRY_AFTER_MS.
  //
  // C11 refactor: replaced setTimeout-spy with behavioral fake-timer
  // advancement. Vitest canonical pattern (https://vitest.dev/api/vi.html):
  // advance time and observe call counts.
  it("clamps post-jitter sleep to MAX_RETRY_AFTER_MS at the cap boundary", async () => {
    vi.useFakeTimers();
    try {
      // Force the worst-case jitter path: floorJitter approaches 1000ms.
      vi.spyOn(Math, "random").mockReturnValue(0.9999);

      let i = 0;
      const fn = vi.fn(async () => {
        i++;
        if (i === 1) {
          throw new RateLimitError({
            status: 429,
            code: "rate_limited",
            message: "exactly at cap",
            raw: null,
            headers: new Headers(),
            retryAfter: 60, // exactly the cap
          });
        }
        return "ok";
      });

      const p = withRetry(fn, 3);
      await vi.advanceTimersByTimeAsync(0); // let first attempt settle
      expect(fn).toHaveBeenCalledTimes(1);

      // Advance to exactly the documented cap. If post-jitter sleep weren't
      // clamped, the second attempt would still be pending at this point
      // (sleep would have been ~60_999ms with worst-case jitter). With the
      // clamp, the sleep is exactly 60_000ms and the second attempt fires
      // within this advancement.
      await vi.advanceTimersByTimeAsync(60_000);
      await p;

      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

// Regression for keryx #I3c: AWS canonical pattern is "exponential backoff with
// full jitter" to prevent thundering herd on rate-limit recovery
// (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
// Our Retry-After honoring path must apply jitter to the sleep, not synchronize
// every client on the exact server-suggested instant.
describe("withRetry — jitter on Retry-After floor (#I3c)", () => {
  // Pragmatic exception to keryx C11 (canonical fake-timer pattern is
  // preferred over setTimeout-spy): this test measures the EXACT sleep
  // duration across multiple runs to prove variance. A purely behavioral
  // assertion (advance by N ms; assert call count) cannot distinguish
  // "varying sleep duration" from "deterministic sleep duration ≤ N",
  // because both produce the same call count after the advancement. The
  // spy is the minimal pattern that records sleep ms per run.
  it("introduces variance across runs when sleeping the Retry-After floor", async () => {
    vi.useFakeTimers();
    try {
      const originalSetTimeout = globalThis.setTimeout;
      const recordedSleeps: number[] = [];
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms: number) => {
        recordedSleeps.push(ms);
        return originalSetTimeout(cb, 0) as ReturnType<typeof setTimeout>;
      }) as typeof globalThis.setTimeout);

      const measure = async (): Promise<number> => {
        const before = recordedSleeps.length;
        let i = 0;
        const fn = vi.fn(async () => {
          i++;
          if (i === 1) {
            throw new RateLimitError({
              status: 429,
              code: "rate_limited",
              message: "slow",
              raw: null,
              headers: new Headers(),
              retryAfter: 5,
            });
          }
          return "ok";
        });
        const p = withRetry(fn, 3);
        await vi.runAllTimersAsync();
        await p;
        return recordedSleeps[before];
      };

      const samples: number[] = [];
      for (let n = 0; n < 8; n++) samples.push(await measure());

      const min = Math.min(...samples);
      const max = Math.max(...samples);
      expect(min, "every sleep must respect the 5s floor").toBeGreaterThanOrEqual(5000);
      expect(max - min, "jitter must introduce variance across runs").toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  // Regression: at Retry-After: 1 (the common rate-limit recovery instant),
  // the pre-fix jitter window was Math.min(1000, retryAfterMs * 0.1) = 100 ms.
  // 100 ms is too narrow to de-correlate N concurrent SDK replicas — they
  // all wake within a 100 ms window and re-fire near-simultaneously. The
  // mature fix per AWS's Decorrelated Jitter pattern is to widen the floor;
  // we use Math.max(2000, retryAfterMs * 0.5). Validated 2026-05-23 against
  // 100 samples per Retry-After value (.keryx/validations/.../issue2-runtime.txt).
  it("Retry-After: 1 spreads across ≥1.5 s window across 100 samples (#issue-2)", async () => {
    vi.useFakeTimers();
    try {
      const recordedSleeps: number[] = [];
      for (let n = 0; n < 100; n++) {
        let i = 0;
        const fn = vi.fn(async () => {
          i++;
          if (i === 1) {
            throw new RateLimitError({
              status: 429,
              code: "rate_limited",
              message: "slow",
              raw: null,
              headers: new Headers(),
              retryAfter: 1,
            });
          }
          return "ok";
        });
        const p = withRetry(fn, {
          maxAttempts: 2,
          baseDelayMs: 1,
          onSleep: (ms) => recordedSleeps.push(ms),
        });
        await vi.runAllTimersAsync();
        await p;
      }
      const min = Math.min(...recordedSleeps);
      const max = Math.max(...recordedSleeps);
      const spread = max - min;
      expect(min, "every sleep must respect the 1000 ms server-supplied floor").toBeGreaterThanOrEqual(1000);
      // Pre-fix bound: spread ≤ 100 ms (Math.min(1000, retryAfterMs*0.1) = 100).
      // Post-fix bound: spread ~Math.max(2000, retryAfterMs*0.5) = 2000 ms.
      // Assert ≥ 1500 ms with safety margin; the floor is 2000 so the spread
      // across 100 samples is overwhelmingly likely to exceed 1500 ms.
      expect(spread, "jitter spread must exceed 1.5 s to break recovery-instant synchronization").toBeGreaterThan(1500);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
