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
        code: "server_error",
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
  it("waits at least Retry-After seconds before the next attempt on 429", async () => {
    vi.useFakeTimers();
    try {
      const sleeps: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, "setTimeout").mockImplementation((cb: any, ms: any) => {
        sleeps.push(ms as number);
        // Resolve immediately so the loop progresses without real wall time.
        return originalSetTimeout(cb, 0) as ReturnType<typeof setTimeout>;
      });

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
      await vi.runAllTimersAsync();
      const result = await p;

      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
      // First sleep must be >= 7000 ms (the server's Retry-After).
      expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
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
});
