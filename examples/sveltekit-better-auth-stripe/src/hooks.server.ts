import type { Handle } from "@sveltejs/kit";
import { CLICK_COOKIE_NAME } from "$lib/server/click-cookie";

// Headers that may be forwarded to linkgrep verbatim. Anything not in this
// list is dropped to avoid leaking the host site's session cookies, auth
// tokens, or CSRF tokens to a third party (OWASP API8:2023 — Security
// Misconfiguration). For the Cookie header specifically we further filter
// to ONLY the click-id cookie pair below.
const FORWARDABLE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "user-agent",
]);

/**
 * Pick only the click-ID cookie pair out of an incoming Cookie header.
 * Keeps attribution working without leaking better-auth session cookies
 * or any other host-site cookies to api.linkgrep.xyz.
 *
 * The cookie name comes from $lib/server/click-cookie so this filter
 * and the better-auth plugin config stay in lockstep — overriding
 * cookieName in one place without the other used to silently strip the
 * renamed cookie at the proxy boundary (keryx 2026-05-23, finding #2).
 */
function filterCookieHeader(raw: string | null): string | null {
  if (!raw) return null;
  const kept = raw
    .split(/;\s*/)
    .filter(pair => pair.split("=")[0]?.trim() === CLICK_COOKIE_NAME);
  return kept.length > 0 ? kept.join("; ") : null;
}

// `/lgr` is the proxy mount point. We require an actual path boundary so that
// `/lgr@attacker.com/x` (userinfo abuse) and `/lgr-evil.com/y` (host-suffix
// abuse) do NOT match — both would otherwise let an attacker steer the
// outbound `fetch` to an arbitrary host via the WHATWG URL authority grammar.
// See https://url.spec.whatwg.org/#authority-state.
const PROXY_PREFIX = "/lgr";

// Upstream budget. Matches the linkgrep SDK's per-request HttpClient timeout
// (packages/sdk/src/http/client.ts:DEFAULT_TIMEOUT_MS). Per MDN, the canonical
// way to bound a fetch is `signal: AbortSignal.timeout(ms)` which aborts with
// a TimeoutError DOMException.
// https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
const UPSTREAM_TIMEOUT_MS = 10_000;

// Hard cap on incoming proxy-POST bodies. Linkgrep track payloads are <2 KiB;
// 64 KiB is generous. Anything above gets a 413.
//
// Two-layer enforcement:
//   1. Pre-flight Content-Length check — fast-fail before reading the body
//      (cheap, but bypassable: a chunked / no-Content-Length client skips it).
//   2. Streaming byte counter wrapped around event.request.body — fires the
//      shared AbortController once the running total exceeds the cap. This
//      catches Transfer-Encoding: chunked uploads (keryx #2 regression).
const MAX_PROXY_BODY_BYTES = 64 * 1024;

/**
 * Read an inbound ReadableStream into a Uint8Array, refusing once the running
 * total exceeds `cap`. Returns `null` for the body if the cap is breached;
 * the caller surfaces a 413.
 *
 * Why buffer rather than stream-through with a cap: when the upstream is
 * permitted to respond mid-body (HTTP duplex), it may decide to reply (e.g.
 * 502 / 401 / 4xx) before our streaming counter reaches the cap boundary.
 * In that race, the response returns to the caller WITHOUT our cap ever
 * firing — false-security streaming. For a 64 KiB cap that's only meant to
 * bound a track-payload (<2 KiB in practice), buffering is the correct
 * shape: cap fires before fetch is called, period.
 *
 * The `abortSignal` parameter is the proxy's master timeout/cancellation
 * signal (set up BEFORE this function is called so the same timer governs
 * both body-buffer and upstream-fetch phases). A slowloris client dripping
 * bytes never reaches the cap; without this signal, the body-read await
 * would hang until the platform's idle timeout, leaking a server slot
 * (keryx C-3, 2026-05-22T1455Z).
 *
 * Pattern: WHATWG-canonical Reader + byte counter from
 * https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams
 */
async function readBodyWithCap(
  src: ReadableStream<Uint8Array>,
  cap: number,
  abortSignal: AbortSignal,
): Promise<{ body: Uint8Array | null; tooLarge: boolean; aborted: boolean }> {
  if (abortSignal.aborted) return { body: null, tooLarge: false, aborted: true };
  const reader = src.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  // Wire the abort signal into the reader so a slow-body trickle gets the
  // same UPSTREAM_TIMEOUT_MS budget as the upstream fetch. reader.cancel()
  // releases the underlying connection per WHATWG Streams.
  const onAbort = () => { void reader.cancel(); };
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        return { body: null, tooLarge: true, aborted: false };
      }
      chunks.push(value);
    }
  } catch (e) {
    // A reader.cancel() race + abort propagation can cause read() to reject
    // with a synthetic error; treat any rejection that lands while the
    // signal is aborted as a deliberate abort.
    if (abortSignal.aborted) return { body: null, tooLarge: false, aborted: true };
    // Preserve the original cause so the outer 502/504 routing in the
    // request handler can distinguish "client disconnected mid-read" from
    // runtime-pressure failures (Uint8Array overflow, OOM, etc.). Per MDN,
    // `new Error(message, { cause })` has been Baseline Widely available
    // since September 2021. Without `cause`, the chained throw at the
    // outer catch loses all diagnostic context.
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error/cause
    throw new Error("body-read-failed", { cause: e });
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
  if (abortSignal.aborted) return { body: null, tooLarge: false, aborted: true };
  if (chunks.length === 0) return { body: null, tooLarge: false, aborted: false };
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.length; }
  return { body: buf, tooLarge: false, aborted: false };
}

export const handle: Handle = async ({ event, resolve }) => {
  const { pathname } = event.url;
  if (pathname !== PROXY_PREFIX && !pathname.startsWith(`${PROXY_PREFIX}/`)) {
    return resolve(event);
  }

  // Slice by length instead of `replace(...)`; replace is unanchored and would
  // strip a `/lgr` occurrence elsewhere in the path.
  const path = pathname.slice(PROXY_PREFIX.length);
  const isAsset = path.startsWith("/script");
  const target = isAsset
    ? `https://cdn.linkgrep.xyz${path}`
    : `https://api.linkgrep.xyz${path}${event.url.search}`;

  const forwarded = new Headers();
  for (const [name, value] of event.request.headers) {
    if (FORWARDABLE_HEADERS.has(name.toLowerCase())) forwarded.set(name, value);
  }
  forwarded.set("host", new URL(target).host);
  forwarded.set("x-forwarded-for", event.getClientAddress());

  const lgrCookie = filterCookieHeader(event.request.headers.get("cookie"));
  if (lgrCookie) forwarded.set("cookie", lgrCookie);

  // Pre-flight body-size check: refuse oversized POSTs without ever reading
  // the stream. Track payloads are small (<2 KiB); 64 KiB headroom is plenty.
  const isBodyMethod = event.request.method !== "GET" && event.request.method !== "HEAD";
  if (isBodyMethod) {
    const declared = event.request.headers.get("content-length");
    if (declared !== null) {
      const len = Number.parseInt(declared, 10);
      if (Number.isFinite(len) && len > MAX_PROXY_BODY_BYTES) {
        return new Response("Payload Too Large", { status: 413 });
      }
    }
  }

  // Shared AbortController hoisted ABOVE the body-buffer step. Pre-fix
  // (keryx C-3, 2026-05-22T1455Z) the controller + timer were set up only
  // around the upstream-fetch call, so a slowloris client dripping bytes
  // into readBodyWithCap held a SvelteKit server slot until the platform's
  // idle timeout (tens of seconds to minutes), entirely outside the
  // documented UPSTREAM_TIMEOUT_MS budget. Now both phases share one timer.
  //
  // Three abort sources fan into `ac.signal`:
  //   (a) client disconnect via event.request.signal
  //   (b) UPSTREAM_TIMEOUT_MS timer
  //   (c) (implicit) the cap-exceeded branch returns directly
  // Pattern: addEventListener composition (engine-breadth-safe on Node 18+).
  // We deliberately avoid AbortSignal.any() to keep the floor at Node 18.0
  // — matches the SDK's `packages/sdk/package.json` engines requirement.
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new Error("client-disconnected"));
  // Canonical check-then-listen idiom (keryx I-2): per WHATWG DOM, an
  // already-aborted signal will NOT fire addEventListener; check explicitly.
  //   https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/aborted
  if (event.request.signal.aborted) {
    ac.abort(event.request.signal.reason ?? new Error("client-disconnected"));
  } else {
    event.request.signal.addEventListener("abort", onClientAbort, { once: true });
  }
  const timeoutId = setTimeout(() => ac.abort(new Error("upstream-timeout")), UPSTREAM_TIMEOUT_MS);

  try {
    // Streaming-cap complement to the Content-Length pre-flight: a client
    // that omits Content-Length (or uses Transfer-Encoding: chunked) skips
    // the header check, so we MUST read the body ourselves with a running
    // byte counter before letting fetch ship it upstream. The read is now
    // bound to `ac.signal` so the UPSTREAM_TIMEOUT_MS budget covers
    // body-buffer + upstream-fetch as a single window.
    let bufferedBody: Uint8Array | null = null;
    if (isBodyMethod && event.request.body) {
      const { body: buf, tooLarge, aborted } = await readBodyWithCap(
        event.request.body,
        MAX_PROXY_BODY_BYTES,
        ac.signal,
      );
      if (tooLarge) return new Response("Payload Too Large", { status: 413 });
      if (aborted) {
        // ac fired during body-buffer — either client disconnect or the
        // UPSTREAM_TIMEOUT_MS timer expired. Both surface as 504; the
        // upstream never received anything.
        return new Response("Upstream Timeout", { status: 504 });
      }
      bufferedBody = buf;
    }

    return await fetch(target, {
      method: event.request.method,
      headers: forwarded,
      body: bufferedBody,
      signal: ac.signal,
    });
  } catch (err) {
    // The AbortController's reason distinguishes timeout vs client-close;
    // both surface as 504 since the upstream did not complete from the
    // caller's perspective. Unknown transport failures (DNS / ECONNRESET /
    // TLS) fall through to 502.
    if (ac.signal.aborted) {
      return new Response("Upstream Timeout", { status: 504 });
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return new Response("Upstream Timeout", { status: 504 });
    }
    return new Response("Bad Gateway", { status: 502 });
  } finally {
    clearTimeout(timeoutId);
    event.request.signal.removeEventListener("abort", onClientAbort);
  }
};
