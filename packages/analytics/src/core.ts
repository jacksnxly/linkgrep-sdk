import { setCookie, getCookieValue } from "./cookie.js";
// Deep subpath import (`linkgrep/protocol` — Node.js exports-field
// encapsulation) so this browser bundle never crosses into the SDK's
// http/client.ts module-level `new TextDecoder()` side effect. The barrel
// `"linkgrep"` would drag that allocation into the CDN-served IIFE even
// though analytics never calls it. Keryx 2026-05-23, finding #1.
//   https://nodejs.org/api/packages.html#subpath-exports
import { DEFAULT_CLICK_ID_COOKIE, CLICK_ID_PATTERN } from "linkgrep/protocol";

export interface LinkgrepBrowserAnalyticsOptions {
  /** Cookie Domain attribute for cross-subdomain attribution (e.g. ".example.com"). */
  cookieDomain?: string;
  /** Override the default cookie name. */
  cookieName?: string;
}

const DEFAULT_MAX_AGE = 90 * 24 * 60 * 60; // 90 days

// DEFAULT_CLICK_ID_COOKIE + CLICK_ID_PATTERN are re-imported from `linkgrep`
// so the browser writer (this package), the server reader
// (`@linkgrep/better-auth`), and any first-party proxy that filters cookies
// all validate against one source of truth. Drift here means cookies
// written by analytics could be silently rejected downstream.
// See packages/sdk/src/protocol.ts.

export function init(opts: LinkgrepBrowserAnalyticsOptions = {}): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const lgId = params.get("lg_id");
  if (!lgId || !CLICK_ID_PATTERN.test(lgId)) return;

  const cookieName = opts.cookieName ?? DEFAULT_CLICK_ID_COOKIE;
  // Read-first guard: skip the document.cookie write on the hottest browser
  // path when the cookie already holds the same value. Without this every
  // pageview with a sticky `?lg_id=` URL re-issues an identical Set-Cookie.
  if (getCookieValue(cookieName) === lgId) return;

  setCookie(cookieName, lgId, {
    domain: opts.cookieDomain,
    maxAge: DEFAULT_MAX_AGE,
    sameSite: "Lax",
    secure: window.location.protocol === "https:",
  });
}

export function getClickId(cookieName: string = DEFAULT_CLICK_ID_COOKIE): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = getCookieValue(cookieName);
  // Symmetric trust boundary with `init()` above: the cookie store is a
  // shared writable surface (XSS, browser extensions, DevTools, third-party
  // scripts can all `document.cookie = "lgr_id=<arbitrary>"`). Re-validate
  // on read to keep the click-ID guarantees the writer enforces — bounded
  // length, URL-safe alphabet, no `;` / `=` / control bytes that could be
  // smuggled downstream into HTTP headers or URL params. OWASP Session
  // Management Cheat Sheet: "Manage Session ID as Any Other User Input."
  return value && CLICK_ID_PATTERN.test(value) ? value : undefined;
}
