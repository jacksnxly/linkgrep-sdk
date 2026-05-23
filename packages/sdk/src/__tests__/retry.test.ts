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

  // Regression for keryx 2026-05-23 review finding #4: WHATWG DOM specifies
  // that `addEventListener("abort", ...)` does NOT fire for a signal that
  // is already aborted at registration time. Pre-fix, if the caller signal
  // aborted during attempt N's catch block (between the throw and the
  // Promise executor that schedules the sleep), the listener attached to
  // an already-aborted signal and never fired. The sleep ran to full
  // duration before the next attempt's pre-flight check picked up the abort.
  //
  // Canonical fix mirrors retry.ts:75-77 — check-then-listen pattern
  // documented at MDN AbortSignal: call signal.throwIfAborted() (or
  // equivalent) BEFORE addEventListener.
  it("aborts the backoff sleep when caller signal aborts inside the catch block", async () => {
    const ac = new AbortController();
    const recordedSleeps: number[] = [];
    let attempts = 0;

    const fn = async () => {
      attempts++;
      if (attempts === 1) {
        // Schedule the abort synchronously — by the time the sleep
        // executor runs, ac.signal is already aborted.
        queueMicrotask(() => ac.abort(new Error("caller-aborted-mid-flight")));
        throw new LinkgrepError({
          status: 500,
          code: "internal_error",
          message: "boom",
          raw: null,
          headers: new Headers(),
        });
      }
      return "unreachable";
    };

    const start = Date.now();
    let caught: unknown;
    try {
      await withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxBackoffMs: 1000,
        // Test observation seam — accepted by InternalRetryOptions only.
        onSleep: (ms) => recordedSleeps.push(ms),
      }, ac.signal);
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    // The sleep was scheduled (we observed it) but the abort should have
    // cut it short well before the full 500ms+jitter elapsed.
    expect(recordedSleeps.length).toBe(1);
    expect(caught).toBeDefined();
    // Allow generous slack for CI jitter; pre-fix this was ~500ms+,
    // post-fix it should be <100ms because the abort fires before the
    // setTimeout completes.
    expect(elapsed, `elapsed=${elapsed}ms — abort should have cut sleep short`).toBeLessThan(200);
  });

  // Regression for keryx 2026-05-23 review finding #5: at the equality
  // boundary `err.retryAfter * 1000 == maxRetryAfterMs`, the pre-fix `>`
  // check fell through to backoff calculation, and the
  // `Math.min(retryAfterMs + jitter, maxRetryAfterMs)` clamp at retry.ts:152
  // truncated the jittered sleep to exactly `maxRetryAfterMs`. All replicas
  // resumed at the same instant — exactly the thundering-herd pattern the
  // jitter exists to prevent (AWS Architecture Blog).
  //
  // Fix: use `>=` so the boundary throws to the caller (who already has
  // err.retryAfter available and can schedule its own retry).
  it("throws when server Retry-After equals maxRetryAfterMs (boundary, refuses to wedge)", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      throw new RateLimitError({
        status: 429,
        code: "rate_limited",
        message: "Slow down",
        raw: null,
        headers: new Headers({ "retry-after": "60" }),
        retryAfter: 60, // exactly default maxRetryAfterMs (60_000 ms)
      });
    });

    let caught: unknown;
    try {
      await withRetry(fn, { maxAttempts: 3, maxRetryAfterMs: 60_000 });
    } catch (e) {
      caught = e;
    }
    // Boundary case: refuse to wedge at the cap — surface the
    // RateLimitError to the caller immediately (matches the
    // documented behavior for `>` cases).
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).retryAfter).toBe(60);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
