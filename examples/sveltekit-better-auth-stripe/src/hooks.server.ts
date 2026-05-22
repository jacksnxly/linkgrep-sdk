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
// 64 KiB is generous. Anything above gets a 413 rather than being buffered.
// Defense-in-depth complement to streaming: even when streaming, a malicious
// content-length forces us to forward megabytes upstream — reject early.
const MAX_PROXY_BODY_BYTES = 64 * 1024;

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

  try {
    return await fetch(target, {
      method: event.request.method,
      headers: forwarded,
      // Stream the request body upstream instead of buffering with .text().
      // Per the WHATWG Fetch spec / MDN Request.duplex, `duplex: "half"` is
      // required whenever the body is a ReadableStream. Without this option
      // Node fetch (undici) rejects the request.
      // https://developer.mozilla.org/en-US/docs/Web/API/Request/duplex
      body: isBodyMethod ? event.request.body : undefined,
      // @ts-expect-error — `duplex` is part of the Fetch spec but the
      // TypeScript lib.dom.d.ts hasn't shipped the field yet (Node fetch /
      // undici requires it for streamed bodies). Track the upstream issue at
      // https://github.com/microsoft/TypeScript/issues/53157 — remove the
      // suppression once TypeScript ships the typing.
      duplex: "half",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    // AbortSignal.timeout fires with a TimeoutError DOMException (MDN).
    // Surface a 504 so the browser gets a visible failure instead of the
    // request hanging or SvelteKit catching it as a 500.
    if (err instanceof Error && err.name === "TimeoutError") {
      return new Response("Upstream Timeout", { status: 504 });
    }
    // Generic transport failure — DNS, ECONNRESET, TLS, etc. Same shape.
    return new Response("Bad Gateway", { status: 502 });
  }
};
