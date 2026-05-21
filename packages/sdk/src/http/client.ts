import { LinkgrepError, parseErrorResponse } from "./errors.js";
import { withRetry } from "./retry.js";

export interface HttpClientOptions {
  token: string;
  baseUrl?: string;
  throwOnError?: boolean;
}

export class HttpClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly throwOnError: boolean;

  constructor(opts: HttpClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.linkgrep.app";
    this.throwOnError = opts.throwOnError ?? false;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    // NOTE on idempotency: the linkgrep server does NOT honor an `Idempotency-Key`
    // header. Sale idempotency is keyed on `invoiceId` in the request body (Redis
    // SET NX, 7-day TTL). Lead idempotency is keyed on workspace+customer+event.
    // Do not add a header here — it would be silently ignored.
    const run = async (): Promise<T> => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
      });

      // 409 from /api/track/* has no body — synthesize a client-side marker
      // so consumers can branch on `result.duplicate` without parsing.
      if (res.status === 409) {
        return { duplicate: true } as T;
      }

      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        throw parseErrorResponse(res, body);
      }

      return res.json() as Promise<T>;
    };

    try {
      return await withRetry(run);
    } catch (err) {
      if (this.throwOnError) throw err;
      if (err instanceof LinkgrepError) {
        console.warn(`[linkgrep] ${err.status} ${err.code}: ${err.message}`);
      } else {
        console.warn("[linkgrep]", err);
      }
      return {} as T;
    }
  }
}
