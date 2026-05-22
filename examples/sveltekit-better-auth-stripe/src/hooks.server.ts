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

  return fetch(target, {
    method: event.request.method,
    headers: forwarded,
    body: event.request.method !== "GET" ? await event.request.text() : undefined,
  });
};
