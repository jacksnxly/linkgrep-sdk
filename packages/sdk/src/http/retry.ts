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
      lastError = err;
      if (attempt < maxAttempts - 1) {
        // Exponential backoff with ±20% jitter.
        const base = Math.pow(2, attempt) * 1000;
        const jitter = base * (0.8 + Math.random() * 0.4);

        // Honor server's Retry-After on 429 (RFC 9110 §10.2.3). Cap to
        // MAX_RETRY_AFTER_MS so a hostile server cannot wedge the SDK.
        let sleepMs = jitter;
        if (err instanceof RateLimitError && err.retryAfter !== undefined) {
          const retryAfterMs = Math.min(err.retryAfter * 1000, MAX_RETRY_AFTER_MS);
          sleepMs = Math.max(retryAfterMs, jitter);
        }
        await new Promise(r => setTimeout(r, sleepMs));
      }
    }
  }

  throw lastError;
}
