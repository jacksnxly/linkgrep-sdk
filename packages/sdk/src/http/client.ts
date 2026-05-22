import { parseErrorResponse } from "./errors.js";
import { withRetry } from "./retry.js";

export interface HttpClientOptions {
  token: string;
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.linkgrep.app";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * NOTE on idempotency: the linkgrep server does NOT honor an `Idempotency-Key`
   * header. Sale idempotency is keyed on `invoiceId` in the request body (Redis
   * SET NX, 7-day TTL). Lead idempotency is keyed on workspace+customer+event.
   * Do not add a header here — it would be silently ignored.
   *
   * 409 handling lives in the track namespace, not here — see track/lead.ts and
   * track/sale.ts. A generic transport must not assume any specific response
   * shape on conflict.
   */
  async post<T>(path: string, body: unknown): Promise<T> {
    const run = async (): Promise<T> => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        // AbortSignal.timeout throws DOMException("...", "TimeoutError") on fire
        // (MDN). retry.ts treats both Abort/Timeout as terminal.
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!res.ok) {
        // Narrow the swallow to JSON parse errors. AbortSignal.timeout binds
        // to the body stream (per MDN AbortSignal), so a timer that fires
        // mid-body-read makes res.json() reject with TimeoutError — that must
        // propagate so retry.ts can treat it as terminal, not get reclassified
        // as a retryable 5xx via parseErrorResponse(res, null).
        const errorBody: unknown = await res.json().catch((e: unknown) => {
          if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw e;
          return null;
        });
        throw parseErrorResponse(res, errorBody);
      }

      return res.json() as Promise<T>;
    };

    return withRetry(run);
  }
}

