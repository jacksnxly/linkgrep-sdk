import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { parseErrorResponse, RateLimitError } from "../http/errors.js";
import { withRetry } from "../http/retry.js";

const BASE = "http://api.linkgrep.test";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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
});

// Regression for keryx #I3c: AWS canonical pattern is "exponential backoff with
// full jitter" to prevent thundering herd on rate-limit recovery
// (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/).
// Our Retry-After honoring path must apply jitter to the sleep, not synchronize
// every client on the exact server-suggested instant.
describe("withRetry — jitter on Retry-After floor (#I3c)", () => {
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
});
