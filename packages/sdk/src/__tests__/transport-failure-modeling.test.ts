// Regression tests for keryx batch validation 2026-05-22T1455Z:
//   - C-1: empty-body / mid-stream transport failure on success path must
//          surface as LinkgrepNetworkError, NOT silently cascade as `null`
//          that crashes the documented `"duplicate" in result` consumer
//          narrowing pattern.
//   - I-1: oversize-response (LinkgrepNetworkError with kind="oversize")
//          is terminal — the SDK must not retry a deterministic failure
//          and amplify load against a misbehaving / hostile origin.
//   - M-2: callers tuning `maxAttempts` upward must not get unbounded
//          exponential blow-up; the per-attempt sleep is capped by
//          maxBackoffMs (AWS SDK convention).
//   - M-3: Retry-After: <ISO-8601> must NOT be silently discarded —
//          server-emitted hints in any RFC-9110-permitted shape feed
//          back into RateLimitError.retryAfter.
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { Linkgrep, LinkgrepNetworkError, RateLimitError } from "../index.js";
// Import the internal-only retry options type via the non-barrel path —
// this hook is deliberately NOT re-exported from `../index.js` (keryx
// 2026-05-23, finding #2). Tests reaching for the observation seam opt
// into the internal contract explicitly.
import type { InternalRetryOptions } from "../http/retry.js";
import { server } from "./msw-server.js";

const BASE = "https://api.linkgrep.test";

afterEach(() => {
  server.resetHandlers();
});

describe("C-1: empty / mid-stream success body surfaces as LinkgrepNetworkError", () => {
  it("empty 200 (Content-Length: 0) throws LinkgrepNetworkError, not silent null", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () => new Response(null, { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "0" } })),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    let threw: unknown;
    let result: unknown;
    try {
      result = await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      threw = e;
    }
    expect(result, "must not return null for empty success body").not.toBe(null);
    expect(threw, "must throw a LinkgrepNetworkError on empty success body").toBeInstanceOf(LinkgrepNetworkError);
  });

  it(".safe() returns ok:false (network error) instead of ok:true with null data", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () => new Response(null, { status: 200, headers: { "Content-Type": "application/json", "Content-Length": "0" } })),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    const r = await lg.track.lead.safe({ eventName: "x", customerExternalId: "u" });
    expect(r.ok, "empty body must be a Result.ok:false branch, not ok:true with null").toBe(false);
    if (!r.ok) expect(r.error).toBeInstanceOf(LinkgrepNetworkError);
  });
});

describe("I-1: oversize response is terminal — no retry amplification", () => {
  it("oversize Content-Length triggers exactly ONE upstream call (not maxAttempts)", async () => {
    let hits = 0;
    server.use(
      http.post(`${BASE}/api/track/lead`, () => {
        hits++;
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json", "Content-Length": String(2 * 1024 * 1024) },
        });
      }),
    );
    const lg = new Linkgrep({
      token: "t",
      baseUrl: BASE,
      retry: { maxAttempts: 3, baseDelayMs: 1 },
    });
    let threw: unknown;
    try {
      await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      threw = e;
    }
    expect(hits, "oversize body is deterministic — retrying wastes 2 upstream calls").toBe(1);
    expect(threw).toBeInstanceOf(LinkgrepNetworkError);
    expect((threw as LinkgrepNetworkError).kind).toBe("oversize");
  });
});

describe("M-2: exponential backoff is clamped by maxBackoffMs", () => {
  it("with maxAttempts=8, no single computed backoff exceeds maxBackoffMs", async () => {
    // Simulate enough 503s to force every retry attempt to compute its
    // backoff. We don't need to sleep — we observe the per-attempt sleep
    // via a captured `onSleep` callback exposed for tests.
    let hits = 0;
    server.use(
      http.post(`${BASE}/api/track/lead`, () => {
        hits++;
        return new HttpResponse(JSON.stringify({ error: { code: "internal_error" } }), { status: 503 });
      }),
    );
    const sleeps: number[] = [];
    const retry: InternalRetryOptions = {
      maxAttempts: 6,
      baseDelayMs: 100,
      maxBackoffMs: 50, // very small cap — every sleep should land here
      // Internal hook for test observation. NOT on the public RetryOptions
      // surface (keryx 2026-05-23, finding #2).
      onSleep: (ms) => { sleeps.push(ms); },
    };
    const lg = new Linkgrep({
      token: "t",
      baseUrl: BASE,
      retry,
    });
    let threw: unknown;
    try {
      await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      threw = e;
    }
    expect(hits, "should attempt 6 times").toBe(6);
    expect(sleeps.length, "should sleep 5 times (maxAttempts - 1)").toBe(5);
    for (const s of sleeps) {
      expect(s, `every sleep must be <= maxBackoffMs (50); got ${s}`).toBeLessThanOrEqual(50);
    }
  });
});

describe("M-3: Retry-After ISO-8601 is honored (not silently dropped)", () => {
  it("Retry-After in ISO-8601 produces a defined retryAfter on RateLimitError", async () => {
    const isoFuture = new Date(Date.now() + 60_000).toISOString();
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        new HttpResponse(JSON.stringify({ error: { code: "rate_limited" } }), {
          status: 429,
          headers: { "retry-after": isoFuture, "content-type": "application/json" },
        }),
      ),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    let err: unknown;
    try {
      await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RateLimitError);
    const ra = (err as RateLimitError).retryAfter;
    expect(ra, `ISO-8601 Retry-After must parse; got retryAfter=${ra}`).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(65); // ~60s + clock skew tolerance
  });
});
