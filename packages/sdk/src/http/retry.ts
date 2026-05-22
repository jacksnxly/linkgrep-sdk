import { LinkgrepError, RateLimitError } from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Cap on server-supplied Retry-After to avoid a malicious / misconfigured
// server stalling the SDK indefinitely. Callers can still surface the raw
// value via RateLimitError.retryAfter if they need to do their own scheduling.
const MAX_RETRY_AFTER_MS = 60_000;

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
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
      if (err instanceof RateLimitError && err.retryAfter !== undefined && err.retryAfter * 1000 > MAX_RETRY_AFTER_MS) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts - 1) {
        // Exponential backoff with ±20% jitter.
        const base = Math.pow(2, attempt) * 1000;
        const jitter = base * (0.8 + Math.random() * 0.4);

        // When honoring Retry-After, add small additive jitter so concurrent
        // clients don't synchronize on the exact recovery instant. AWS calls
        // this the "thundering herd" prevention pattern (AWS SDK retry docs:
        // https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
        let sleepMs = jitter;
        if (err instanceof RateLimitError && err.retryAfter !== undefined) {
          const retryAfterMs = err.retryAfter * 1000;
          const floorJitter = Math.random() * Math.min(1000, retryAfterMs * 0.1);
          // Clamp post-jitter to MAX_RETRY_AFTER_MS so the documented cap
          // ("won't stall longer than 60s") holds end-to-end. Without this
          // clamp, retryAfter=60 + worst-case jitter could sleep ~61s,
          // breaching the invariant the caller relies on.
          sleepMs = Math.min(
            Math.max(retryAfterMs + floorJitter, jitter),
            MAX_RETRY_AFTER_MS,
          );
        }
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }
  }

  throw lastError;
}
