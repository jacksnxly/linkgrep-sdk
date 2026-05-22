import { LinkgrepError, LinkgrepNetworkError, isTerminalTransportError, parseErrorResponse } from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";

export interface HttpClientOptions {
  token: string;
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Each retry attempt restarts the timer. Default 10s. */
  timeoutMs?: number;
  /** Retry policy. See RetryOptions for tunable knobs. Default: 3 attempts, 1s base, 60s cap. */
  retry?: RetryOptions;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Hard cap on response-body size. Linkgrep track responses are <2 KiB; 1 MiB
// is generous headroom that still bounds the heap a misbehaving / hostile /
// MITM origin can force the SDK to allocate. Applied to both success and
// error paths in post() below.
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Stream-read a Response body into JSON with a hard byte cap. Rejects with
 * LinkgrepNetworkError before allocating beyond `capBytes`. AbortError /
 * TimeoutError on the underlying stream propagate verbatim (so retry.ts
 * treats them as terminal, not retryable).
 *
 * Returns `null` for empty bodies (matching the previous res.json().catch(()
 * => null) error-path behavior). Per WHATWG Streams: ReadableStreamDefault-
 * Reader.cancel() releases the underlying connection once the cap fires.
 * https://developer.mozilla.org/en-US/docs/Web/API/ReadableStreamDefaultReader/cancel
 */
/** @internal exported for regression tests; not part of the public API surface. */
export async function readJsonWithByteCap(res: Response, capBytes: number): Promise<unknown> {
  if (res.body === null) return null;
  const reader = res.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > capBytes) {
        await reader.cancel();
        throw new LinkgrepNetworkError(
          "oversize",
          `response too large: >${capBytes} bytes (cap ${capBytes})`,
        );
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof LinkgrepNetworkError) throw e;
    // AbortSignal.timeout binds to the body stream (per MDN AbortSignal),
    // so a timer that fires mid-body-read makes read() reject with
    // TimeoutError — that must propagate so retry.ts can treat it as
    // terminal, not get reclassified as a retryable 5xx.
    if (isTerminalTransportError(e)) throw e;
    // Mid-stream transport failure (network reset, premature close, undici
    // "terminated"). Surface as a tagged LinkgrepNetworkError so the
    // documented `LinkgrepError | LinkgrepNetworkError` union holds — pre-fix,
    // we returned `null` here which then cascaded as `null as T` on the
    // success path and crashed consumer narrowing (`"duplicate" in null`).
    throw LinkgrepNetworkError.from(e);
  }
  if (chunks.length === 0) return null;
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.length;
  }
  const text = new TextDecoder().decode(buf);
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    // Non-JSON 200 body — surface as a network error rather than null. A
    // server returning malformed JSON is a real, observable defect; null
    // would silently cascade through `parsed as T` as if it succeeded.
    throw new LinkgrepNetworkError("network", `non-JSON response body: ${e instanceof Error ? e.message : String(e)}`, e);
  }
}

export class HttpClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions | undefined;

  constructor(opts: HttpClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.linkgrep.app";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry;
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
    const run = async (perAttemptBudgetSignal?: AbortSignal): Promise<T> => {
      // Per-attempt timeout. When `retry.totalBudgetMs` is set, withRetry
      // hands us an additional signal that fires when the remaining budget
      // expires — composed via AbortSignal.any so whichever fires first
      // wins. Node 18.17+/20.3+ ship AbortSignal.any (MDN); the SDK's
      // engines floor is `>=18`, so consumers on 18.0–18.16 lose the budget
      // narrowing but still get the per-attempt timeout — a strict
      // improvement over the pre-fix behavior where neither was bounded
      // per-attempt by the budget.
      const perAttemptTimeout = AbortSignal.timeout(this.timeoutMs);
      const signal =
        perAttemptBudgetSignal !== undefined && typeof AbortSignal.any === "function"
          ? AbortSignal.any([perAttemptTimeout, perAttemptBudgetSignal])
          : perAttemptTimeout;

      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      // Pre-flight response-size check: refuse to parse oversized bodies into
      // heap. Applied BEFORE .ok branching so 4xx/5xx envelopes are guarded
      // too. A misbehaving / MITM origin can otherwise force multi-MiB JSON
      // allocation in the SDK consumer's process.
      //
      // Two-layer defense:
      //   1. Fast-fail on declared Content-Length (no body read needed).
      //   2. Stream-read with a running byte counter so chunked / missing-CL
      //      responses cannot bypass the cap. WHATWG-canonical pattern using
      //      getReader() + early cancel(); see
      //      https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams
      const declared = res.headers.get("content-length");
      if (declared !== null) {
        const len = Number.parseInt(declared, 10);
        if (Number.isFinite(len) && len > DEFAULT_MAX_RESPONSE_BYTES) {
          throw new LinkgrepNetworkError(
            "oversize",
            `response too large: ${len} bytes (cap ${DEFAULT_MAX_RESPONSE_BYTES})`,
          );
        }
      }

      const parsed = await readJsonWithByteCap(res, DEFAULT_MAX_RESPONSE_BYTES);

      if (!res.ok) {
        throw parseErrorResponse(res, parsed);
      }

      // Empty 200 / null-parsed-success is treated as a transport failure
      // rather than `null as T`. Track endpoints are documented to return a
      // JSON envelope on success; a missing body indicates the upstream cut
      // off mid-response or never wrote one. Pre-fix, `null as T` cascaded
      // into the documented `"duplicate" in result` consumer narrowing
      // pattern with `TypeError: Cannot use 'in' operator in null`.
      if (parsed === null) {
        throw new LinkgrepNetworkError(
          "network",
          "empty response body on 2xx — upstream returned no payload",
        );
      }

      return parsed as T;
    };

    // Wrap transport failures in the sealed LinkgrepNetworkError union so the
    // throwing entry points honor the same contract as `.safe()` / `toResult`.
    // Without this seam, raw DOMException("TimeoutError"|"AbortError") and
    // TypeError("fetch failed") leak past the documented union — defeating
    // `try { ... } catch (e instanceof LinkgrepError) { ... }` at every caller.
    // `LinkgrepNetworkError` instances are passed through unchanged so the
    // semantic `kind` (e.g. "oversize") survives — re-wrapping via .from()
    // would collapse every kind back to "network" via classify().
    try {
      return await withRetry(run, this.retry);
    } catch (err) {
      if (err instanceof LinkgrepError) throw err;
      if (err instanceof LinkgrepNetworkError) throw err;
      throw LinkgrepNetworkError.from(err);
    }
  }
}

