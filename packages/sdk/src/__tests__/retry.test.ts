import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../http/retry.js";
import { LinkgrepError, RateLimitError } from "../http/errors.js";

describe("withRetry", () => {
  it("retries on 429 up to 3 times and succeeds on 3rd attempt", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3)
        throw new LinkgrepError({
          status: 429,
          code: "rate_limited",
          message: "Too many requests",
          raw: null,
          headers: new Headers(),
        });
      return "ok";
    });

    const result = await withRetry(fn, 3);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 401", async () => {
    const fn = vi.fn(async () => {
      throw new LinkgrepError({
        status: 401,
        code: "unauthorized",
        message: "Unauthorized",
        raw: null,
        headers: new Headers(),
      });
    });

    await expect(withRetry(fn, 3)).rejects.toThrow(LinkgrepError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const fn = vi.fn(async () => {
      throw new LinkgrepError({
        status: 500,
        code: "internal_error",
        message: "Internal Server Error",
        raw: null,
        headers: new Headers(),
      });
    });

    await expect(withRetry(fn, 3)).rejects.toThrow(LinkgrepError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // Regression for keryx issue #5: withRetry must honor server's Retry-After
  // header from RateLimitError (RFC 9110 §10.2.3). Pre-fix it always used
  // exponential backoff, ignoring the server's explicit wait directive.
  //
  // C11 refactor: uses behavioral fake-timer assertions
  // (advanceTimersByTimeAsync) instead of spying on setTimeout. The original
  // pattern coupled the test to the specific `setTimeout` primitive; a
  // refactor to scheduler.wait / setImmediate / Promise.then would have broken
  // it despite identical observable behavior. Vitest's canonical pattern from
  // https://vitest.dev/api/vi.html is `useFakeTimers()` + `advanceTimersByTimeAsync()`.
  it("waits at least Retry-After seconds before the next attempt on 429", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw new RateLimitError({
            status: 429,
            code: "rate_limited",
            message: "Slow down",
            raw: null,
            headers: new Headers({ "retry-after": "7" }),
            retryAfter: 7,
          });
        }
        return "ok";
      });

      const p = withRetry(fn, 3);

      // Let the microtask queue settle so the first attempt + throw lands.
      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);

      // Just before Retry-After: second attempt MUST NOT have fired yet. The
      // retry-after floor is 7000ms; jitter only ADDS, never subtracts, so 6999
      // is strictly below the soonest possible second call.
      await vi.advanceTimersByTimeAsync(6999);
      expect(fn).toHaveBeenCalledTimes(1);

      // Past the worst-case jitter ceiling: retry-after + Math.max(2000,
      // retryAfterMs * 0.5) = 7000 + max(2000, 3500) = 7000 + 3500 = 10500 ms.
      // Advance to 12000 ms total for safety. The jitter widening (issue #2)
      // raised this ceiling from ~7700 ms to ~10500 ms.
      await vi.advanceTimersByTimeAsync(5001);
      const result = await p;

      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression for keryx issue #6: AbortError / TimeoutError must NOT retry.
  // A user-cancelled or timed-out request is terminal; retrying defeats the
  // intent and burns the budget.
  it("does not retry on AbortError (user cancellation)", async () => {
    const err = new DOMException("Aborted", "AbortError");
    const fn = vi.fn(async () => { throw err; });
    await expect(withRetry(fn, 3)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry on TimeoutError (AbortSignal.timeout)", async () => {
    const err = new DOMException("Request timed out", "TimeoutError");
    const fn = vi.fn(async () => { throw err; });
    await expect(withRetry(fn, 3)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // Regression for keryx batch-2 #I15: callers must be able to tune retry
  // behavior via a RetryOptions object. Previously maxAttempts was the only
  // knob, hard-coded as the second arg. The new surface exposes maxAttempts,
  // baseDelayMs, and maxRetryAfterMs with safe defaults.
  //
  // This test uses maxAttempts:1 so the loop exits without ever reaching the
  // sleep path — avoiding cross-test fake-timer / setTimeout-spy leakage seen
  // when this test ran alongside the existing Retry-After fake-timer tests.
  it("accepts a RetryOptions object (single-attempt skips the sleep path)", async () => {
    let attempts = 0;
    async function fn() {
      attempts++;
      throw new LinkgrepError({
        status: 500,
        code: "internal_error",
        message: "Internal Server Error",
        raw: null,
        headers: new Headers(),
      });
    }
    let caught: unknown;
    try {
      await withRetry(fn, { maxAttempts: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LinkgrepError);
    expect(attempts).toBe(1);
  });

  // Regression for keryx Important #5 (validated 2026-05-22): withRetry must
  // honor an opt-in `totalBudgetMs` ceiling on overall wall time, including
  // sleeps. Pre-fix a single call with `timeoutMs: 1000` against a
  // 429 + Retry-After: 5 upstream blocked for ~10.5s (10.51× the per-attempt
  // setting). The new knob mirrors the well-established split between
  // per-attempt and total-call timeouts (gRPC "deadline" / Apache HttpClient
  // "request_timeout" vs "socket_timeout").
  //
  // Behavioral assertion via fake timers (canonical vitest pattern, no
  // setTimeout-spy coupling).
  it("respects totalBudgetMs and throws lastError before the next sleep would exceed the cap", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts++;
        throw new RateLimitError({
          status: 429,
          code: "rate_limited",
          message: "Slow down",
          raw: null,
          headers: new Headers({ "retry-after": "10" }),
          retryAfter: 10,
        });
      });

      const p = withRetry(fn, { maxAttempts: 5, totalBudgetMs: 2000 }).catch(e => e);

      // First attempt fires immediately; the next sleep would be ≥10s
      // (Retry-After: 10 + floorJitter), well past the 2s budget. The
      // retry loop must NOT sleep and must throw the lastError now.
      await vi.advanceTimersByTimeAsync(0);
      const err = await p;
      expect(err).toBeInstanceOf(RateLimitError);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Verifies the back-compat path: passing a bare number still works.
  it("back-compat: accepts a bare maxAttempts number", async () => {
    let attempts = 0;
    async function fn() {
      attempts++;
      throw new LinkgrepError({
        status: 500,
        code: "internal_error",
        message: "Internal Server Error",
        raw: null,
        headers: new Headers(),
      });
    }
    let caught: unknown;
    try {
      await withRetry(fn, 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LinkgrepError);
    expect(attempts).toBe(1);
  });
});
