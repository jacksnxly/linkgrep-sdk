import { LinkgrepError, LinkgrepNetworkError, isTerminalTransportError, parseErrorResponse } from "./errors.js";
import { withRetry, type RetryOptions } from "./retry.js";

/**
 * Pluggable fetch implementation. Defaults to `globalThis.fetch`. Supply your
 * own when running under Cloudflare Workers (use the binding's `fetch`), with
 * a custom undici Agent (mTLS, certificate pinning, proxy), or in tests that
 * cannot rely on MSW global interception (Web Workers, Bun, Deno).
 *
 * Shape matches the WHATWG `fetch` signature so existing implementations
 * drop in without adapters.
 */
export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  token: string;
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Each retry attempt restarts the timer. Default 10s. */
  timeoutMs?: number;
  /** Retry policy. See RetryOptions for tunable knobs. Default: 3 attempts, 1s base, 60s cap. */
  retry?: RetryOptions;
  /**
   * Caller-supplied AbortSignal. Aborts the in-flight fetch and short-circuits
   * any pending backoff sleep. Composed with the per-attempt timeout and the
   * `retry.totalBudgetMs` budget via `AbortSignal.any` (Node 18.17+/20.3+).
   * On engines without `AbortSignal.any`, the caller signal degrades to a
   * pre-attempt check (still better than the pre-fix behavior where the SDK
   * was uninterruptible mid-retry).
   */
  signal?: AbortSignal;
  /**
   * Pluggable fetch implementation. Default: `globalThis.fetch`.
   */
  fetch?: Fetcher;
}

const DEFAULT_TIMEOUT_MS = 10_000;

// Hard cap on response-body size. Linkgrep track responses are <2 KiB; 1 MiB
// is generous headroom that still bounds the heap a misbehaving / hostile /
// MITM origin can force the SDK to allocate. Applied to both success and
// error paths in post() below.
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

// Module-level decoder. TextDecoder is stateless across decode() calls when
// `stream: false` (the default) — every call is treated as a complete decode
// and the decoder state resets. Reusing a single instance across requests
// avoids the per-response ICU-backed constructor allocation, which is
// non-trivial in V8 under sustained throughput. (Node `util.TextDecoder`
// docs: "Each call is treated as a complete decode operation ... The decoder
// can be reused for subsequent calls." MDN TextDecoder — same semantics.)
const RESPONSE_DECODER = new TextDecoder();

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
  const text = RESPONSE_DECODER.decode(buf);
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
  private readonly callerSignal: AbortSignal | undefined;
  private readonly fetchImpl: Fetcher;

  constructor(opts: HttpClientOptions) {
    this.token = opts.token;
    this.baseUrl = opts.baseUrl ?? "https://api.linkgrep.xyz";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = opts.retry;
    this.callerSignal = opts.signal;
    // Bind explicitly to avoid `Illegal invocation` on platforms (Workers,
    // Deno) where `globalThis.fetch` is a method that requires `this`.
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
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
      // Per-attempt signal composition: the per-attempt timeout, the
      // budget-derived signal (when `retry.totalBudgetMs` is set), and
      // the caller-supplied signal all race for the abort — whichever
      // fires first wins. Node 18.17+/20.3+ ship AbortSignal.any (MDN);
      // the SDK's engines floor is `>=18`, so consumers on 18.0–18.16
      // get only the per-attempt timeout — a strict improvement over
      // the pre-fix behavior where neither budget nor caller signal
      // applied at all.
      //   https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static
      if (this.callerSignal?.aborted) {
        // Honor an already-aborted caller signal pre-flight; per WHATWG
        // DOM, addEventListener("abort") does NOT fire for signals that
        // are already aborted.
        throw new LinkgrepNetworkError("abort", "caller AbortSignal was already aborted", this.callerSignal.reason);
      }
      const perAttemptTimeout = AbortSignal.timeout(this.timeoutMs);
      const signals: AbortSignal[] = [perAttemptTimeout];
      if (perAttemptBudgetSignal) signals.push(perAttemptBudgetSignal);
      if (this.callerSignal) signals.push(this.callerSignal);
      const signal =
        signals.length > 1 && typeof AbortSignal.any === "function"
          ? AbortSignal.any(signals)
          : perAttemptTimeout;

      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
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
    //
    // The caller AbortSignal is also forwarded into withRetry so the
    // backoff sleep is interruptible (pre-fix, `setTimeout` could not be
    // cancelled mid-sleep).
    try {
      return await withRetry(run, this.retry, this.callerSignal);
    } catch (err) {
      if (err instanceof LinkgrepError) throw err;
      if (err instanceof LinkgrepNetworkError) throw err;
      throw LinkgrepNetworkError.from(err);
    }
  }
}

