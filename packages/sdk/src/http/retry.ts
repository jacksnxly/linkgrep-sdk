import { LinkgrepError } from "./errors.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof LinkgrepError && !RETRYABLE_STATUS.has(err.status)) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts - 1) {
        // exponential backoff with ±20% jitter
        const base = Math.pow(2, attempt) * 1000;
        const jitter = base * (0.8 + Math.random() * 0.4);
        await new Promise(r => setTimeout(r, jitter));
      }
    }
  }

  throw lastError;
}
