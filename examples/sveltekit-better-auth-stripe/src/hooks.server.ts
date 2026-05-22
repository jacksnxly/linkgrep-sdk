import type { Handle } from "@sveltejs/kit";

// Headers that may be forwarded to linkgrep verbatim. Anything not in this
// list is dropped to avoid leaking the host site's session cookies, auth
// tokens, or CSRF tokens to a third party (OWASP API8:2023 — Security
// Misconfiguration). For the Cookie header specifically we further filter
// to ONLY the lgr_id pair below.
const FORWARDABLE_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-type",
  "user-agent",
]);

const LINKGREP_COOKIE_NAME = "lgr_id";

/**
 * Pick only the lgr_id pair out of an incoming Cookie header. Keeps attribution
 * working without leaking better-auth session cookies or any other host-site
 * cookies to api.linkgrep.app.
 */
function filterCookieHeader(raw: string | null): string | null {
  if (!raw) return null;
  const kept = raw
    .split(/;\s*/)
    .filter(pair => pair.split("=")[0]?.trim() === LINKGREP_COOKIE_NAME);
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
 * Pattern: WHATWG-canonical Reader + byte counter from
 * https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams
 */
async function readBodyWithCap(
  src: ReadableStream<Uint8Array>,
  cap: number,
): Promise<{ body: Uint8Array | null; tooLarge: boolean }> {
  const reader = src.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > cap) {
        await reader.cancel();
        return { body: null, tooLarge: true };
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (chunks.length === 0) return { body: null, tooLarge: false };
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.length; }
  return { body: buf, tooLarge: false };
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
    ? `https://cdn.linkgrep.app${path}`
    : `https://api.linkgrep.app${path}${event.url.search}`;

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

  // Streaming-cap complement to the Content-Length pre-flight: a client that
  // omits Content-Length (or uses Transfer-Encoding: chunked) skips the
  // header check, so we MUST read the body ourselves with a running byte
  // counter before letting fetch ship it upstream. Buffer-and-cap rather
  // than stream-through-with-cap — see readBodyWithCap docstring for the
  // race-condition rationale.
  let bufferedBody: Uint8Array | null = null;
  if (isBodyMethod && event.request.body) {
    const { body: buf, tooLarge } = await readBodyWithCap(event.request.body, MAX_PROXY_BODY_BYTES);
    if (tooLarge) return new Response("Payload Too Large", { status: 413 });
    bufferedBody = buf;
  }

  // Shared AbortController fans two abort sources into one upstream-fetch
  // signal: (a) browser disconnect via event.request.signal — pre-fix, a
  // closed client connection left the upstream fetch hanging until the
  // timeout fired, leaking a server slot for up to UPSTREAM_TIMEOUT_MS;
  // (b) the upstream timeout. Pattern: addEventListener-based composition
  // works on all Node 18+; AbortSignal.any() (Node 18.17+/20.3+) is the
  // syntactic-sugar equivalent we intentionally avoid for engine breadth.
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new Error("client-disconnected"));
  event.request.signal.addEventListener("abort", onClientAbort, { once: true });
  const timeoutId = setTimeout(() => ac.abort(new Error("upstream-timeout")), UPSTREAM_TIMEOUT_MS);

  try {
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
