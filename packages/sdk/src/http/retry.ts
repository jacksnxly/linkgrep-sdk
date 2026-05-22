import { LinkgrepError, RateLimitError, isTerminalTransportError } from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Caller-tunable retry policy. Mirrors the knob surface of mature retry
 * libraries (AWS SDK retry config, undici Retry interceptor): a max number
 * of attempts, a base delay for the exponential backoff, and a hard cap on
 * how long the SDK is willing to wait per attempt for a server-supplied
 * Retry-After.
 *
 * Refs:
 *   https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *   https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html
 */
export interface RetryOptions {
  /** Total attempts INCLUDING the first call. Default: 3. */
  maxAttempts?: number;
  /** Base exponential-backoff delay in ms. Default: 1000. */
  baseDelayMs?: number;
  /**
   * Hard ceiling on the per-attempt computed backoff sleep, in ms. Default
   * 30_000 — matches AWS SDK retry-mode-standard `max_backoff = 20 s` plus
   * post-jitter headroom. Without this cap, a caller tuning `maxAttempts`
   * upward gets exponential blow-up (2^N * baseDelayMs) that the
   * documented `maxRetryAfterMs` cap does NOT constrain (that one applies
   * only to server-supplied Retry-After).
   */
  maxBackoffMs?: number;
  /** Hard ceiling on the SDK's wait for server Retry-After, in ms. Default: 60_000. */
  maxRetryAfterMs?: number;
  /**
   * Overall wall-time budget (in ms) across all attempts AND sleeps for a
   * single .post() call. Opt-in; when undefined the SDK has no total budget
   * (current behavior). When set, withRetry throws the most recent error
   * before any sleep that would exceed `startedAt + totalBudgetMs`, and
   * narrows the per-attempt timeout to `min(timeoutMs, remaining)` so the
   * documented wall-time bound holds end-to-end (not just across sleeps).
   *
   * Mirrors the canonical split between per-attempt timeout (`timeoutMs`)
   * and total call deadline in mature HTTP clients — gRPC "deadline"
   * (https://grpc.io/docs/guides/deadlines/), Apache HttpClient
   * `request_timeout` vs `socket_timeout`, AWS SDK `call_attempt_timeout`
   * vs `call_timeout`.
   */
  totalBudgetMs?: number;
  /**
   * Internal hook used by regression tests to observe each computed sleep
   * without actually advancing wall time. Not part of the documented public
   * surface. Fires after the backoff is clamped and any budget gate would
   * have allowed the sleep — i.e. with the same value the runtime will
   * pass to setTimeout.
   * @internal
   */
  onSleep?: (ms: number) => void;
}

const DEFAULT_RETRY: Required<Omit<RetryOptions, "totalBudgetMs" | "onSleep">> = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxBackoffMs: 30_000,
  maxRetryAfterMs: 60_000,
};

export async function withRetry<T>(
  fn: (perAttemptSignal?: AbortSignal) => Promise<T>,
  options: RetryOptions | number = DEFAULT_RETRY,
): Promise<T> {
  // Back-compat: old signature accepted a bare `maxAttempts` number.
  const opts =
    typeof options === "number"
      ? { ...DEFAULT_RETRY, maxAttempts: options }
      : { ...DEFAULT_RETRY, ...options };
  const { maxAttempts, baseDelayMs, maxBackoffMs, maxRetryAfterMs, totalBudgetMs, onSleep } = opts;
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // Budget-derived per-attempt signal. When `totalBudgetMs` is set, the
      // per-attempt timer at the call site is narrowed via this signal to
      // `min(perAttemptTimeoutMs, remaining)` — without this, an in-flight
      // attempt could spend up to `timeoutMs` past `startedAt + totalBudgetMs`,
      // breaching the documented overall wall-time contract.
      const perAttemptSignal =
        totalBudgetMs !== undefined
          ? AbortSignal.timeout(Math.max(0, totalBudgetMs - (Date.now() - startedAt)))
          : undefined;
      return await fn(perAttemptSignal);
    } catch (err) {
      // Terminal transport failures (AbortError, TimeoutError, oversize
      // response) — retrying either defeats the caller's intent or amplifies
      // load against a deterministic failure. Predicate is centralized in
      // errors.ts so the three call sites (here, client.ts body-reader catch,
      // LinkgrepNetworkError.classify) share one definition.
      if (isTerminalTransportError(err)) {
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
        // Exponential backoff clamped to maxBackoffMs (AWS SDK convention —
        // max_backoff = 20s in standard retry mode, plus our post-jitter
        // headroom: https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
        // Without this clamp, a caller tuning `maxAttempts` upward gets
        // 2^N * baseDelayMs blow-up that the `maxRetryAfterMs` knob does
        // NOT constrain (that one applies only to server-supplied
        // Retry-After).
        const base = Math.min(Math.pow(2, attempt) * baseDelayMs, maxBackoffMs);
        const jitter = base * (0.8 + Math.random() * 0.4);

        // When honoring Retry-After, add small additive jitter so concurrent
        // clients don't synchronize on the exact recovery instant. AWS calls
        // this the "thundering herd" prevention pattern.
        let sleepMs = jitter;
        if (err instanceof RateLimitError && err.retryAfter !== undefined) {
          const retryAfterMs = err.retryAfter * 1000;
          const floorJitter = Math.random() * Math.min(1000, retryAfterMs * 0.1);
          // Clamp post-jitter to maxRetryAfterMs so the documented cap holds
          // end-to-end. Without this clamp, retryAfter at exactly the cap +
          // worst-case jitter could sleep ~1s past the cap.
          sleepMs = Math.min(
            Math.max(retryAfterMs + floorJitter, jitter),
            maxRetryAfterMs,
          );
        } else {
          // Non-Retry-After backoff: clamp the jittered exponential to
          // maxBackoffMs (the upper jitter band can exceed the unjittered
          // base by 20%, so re-clamp post-jitter).
          sleepMs = Math.min(sleepMs, maxBackoffMs);
        }
        // Total-budget gate: if the projected sleep would push the overall
        // wall time past the caller-specified ceiling, give up now rather
        // than sleep first and throw later.
        if (totalBudgetMs !== undefined) {
          const elapsed = Date.now() - startedAt;
          if (elapsed + sleepMs >= totalBudgetMs) {
            throw lastError;
          }
        }
        onSleep?.(sleepMs);
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }
  }

  throw lastError;
}
