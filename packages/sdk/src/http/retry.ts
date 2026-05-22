import { LinkgrepError, RateLimitError } from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Caller-tunable retry policy. Mirrors the knob surface of mature retry
 * libraries (AWS SDK retry config, undici Retry interceptor): a max number
 * of attempts, a base delay for the exponential backoff, and a hard cap on
 * how long the SDK is willing to wait per attempt for a server-supplied
 * Retry-After. AWS Architecture Blog on exponential backoff + jitter:
 * https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export interface RetryOptions {
  /** Total attempts INCLUDING the first call. Default: 3. */
  maxAttempts?: number;
  /** Base exponential-backoff delay in ms. Default: 1000. */
  baseDelayMs?: number;
  /** Hard ceiling on the SDK's wait for server Retry-After, in ms. Default: 60_000. */
  maxRetryAfterMs?: number;
  /**
   * Overall wall-time budget (in ms) across all attempts AND sleeps for a
   * single .post() call. Opt-in; when undefined the SDK has no total budget
   * (current behavior). When set, withRetry throws the most recent error
   * before any sleep that would exceed `startedAt + totalBudgetMs`.
   *
   * Mirrors the canonical split between per-attempt timeout (`timeoutMs`)
   * and total call deadline in mature HTTP clients — gRPC "deadline",
   * Apache HttpClient `request_timeout` vs `socket_timeout`, AWS SDK
   * `call_attempt_timeout` vs `call_timeout`.
   */
  totalBudgetMs?: number;
}

const DEFAULT_RETRY: Required<Omit<RetryOptions, "totalBudgetMs">> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxRetryAfterMs: 60_000,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions | number = DEFAULT_RETRY,
): Promise<T> {
  // Back-compat: old signature accepted a bare `maxAttempts` number.
  const opts =
    typeof options === "number"
      ? { ...DEFAULT_RETRY, maxAttempts: options }
      : { ...DEFAULT_RETRY, ...options };
  const { maxAttempts, baseDelayMs, maxRetryAfterMs, totalBudgetMs } = opts;
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // AbortError (user cancellation) and TimeoutError (AbortSignal.timeout)
      // are terminal — retrying defeats the caller's intent.
      // Names per WHATWG Fetch + MDN AbortSignal.timeout_static.
      if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        throw err;
      }
      if (err instanceof LinkgrepError && !RETRYABLE_STATUS.has(err.status)) {
        throw err;
      }
      // Honor server's Retry-After on 429 (RFC 9110 §10.2.3). If it exceeds
      // our cap, surface the RateLimitError to the caller instead of silently
      // truncating — the caller has err.retryAfter and can schedule its own
      // retry. Refusing to wedge here protects the SDK budget without lying
      // to the application about how long the server actually asked for.
      if (err instanceof RateLimitError && err.retryAfter !== undefined && err.retryAfter * 1000 > maxRetryAfterMs) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts - 1) {
        // Exponential backoff with ±20% jitter.
        const base = Math.pow(2, attempt) * baseDelayMs;
        const jitter = base * (0.8 + Math.random() * 0.4);

        // When honoring Retry-After, add small additive jitter so concurrent
        // clients don't synchronize on the exact recovery instant. AWS calls
        // this the "thundering herd" prevention pattern (AWS SDK retry docs:
        // https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
        let sleepMs = jitter;
        if (err instanceof RateLimitError && err.retryAfter !== undefined) {
          const retryAfterMs = err.retryAfter * 1000;
          const floorJitter = Math.random() * Math.min(1000, retryAfterMs * 0.1);
          // Clamp post-jitter to maxRetryAfterMs so the documented cap holds
          // end-to-end. Without this clamp, retryAfter at exactly the cap +
          // worst-case jitter could sleep ~1s past the cap, breaching the
          // invariant the caller relies on.
          sleepMs = Math.min(
            Math.max(retryAfterMs + floorJitter, jitter),
            maxRetryAfterMs,
          );
        }
        // Total-budget gate: if the projected sleep would push the overall
        // wall time past the caller-specified ceiling, give up now rather
        // than sleep first and throw later. Without this, a caller's
        // `timeoutMs: 1000` could still block ~10s on a 429+Retry-After loop.
        if (totalBudgetMs !== undefined) {
          const elapsed = Date.now() - startedAt;
          if (elapsed + sleepMs >= totalBudgetMs) {
            throw lastError;
          }
        }
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }
  }

  throw lastError;
}
