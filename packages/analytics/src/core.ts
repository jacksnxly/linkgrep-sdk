import { setCookie, getCookieValue } from "./cookie.js";
import { DEFAULT_CLICK_ID_COOKIE, CLICK_ID_PATTERN } from "linkgrep";

export interface LinkgrepBrowserAnalyticsOptions {
  /** Cookie Domain attribute for cross-subdomain attribution (e.g. ".example.com"). */
  cookieDomain?: string;
  /** Override the default cookie name. */
  cookieName?: string;
}

/**
 * @deprecated Import `DEFAULT_CLICK_ID_COOKIE` from `linkgrep` instead.
 * Re-exported here for back-compat with existing consumers; will be removed
 * in v0.2. The constant has moved to the SDK so it can be the single source
 * of truth across the browser writer (this package), the server reader
 * (`@linkgrep/better-auth`), and any first-party proxy that filters cookies.
 */
export const DEFAULT_COOKIE_NAME: string = DEFAULT_CLICK_ID_COOKIE;
const DEFAULT_MAX_AGE = 90 * 24 * 60 * 60; // 90 days

// CLICK_ID_PATTERN is re-imported from linkgrep so both browser and server
// validate against the same regex — drift here means cookies written by
// analytics could be silently rejected by the proxy filter or by future
// server-side click-ID-shape validation. See packages/sdk/src/protocol.ts.

export function init(opts: LinkgrepBrowserAnalyticsOptions = {}): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  const lgId = params.get("lg_id");
  if (!lgId || !CLICK_ID_PATTERN.test(lgId)) return;

  setCookie(opts.cookieName ?? DEFAULT_COOKIE_NAME, lgId, {
    domain: opts.cookieDomain,
    maxAge: DEFAULT_MAX_AGE,
    sameSite: "Lax",
    secure: window.location.protocol === "https:",
  });
}

export function getClickId(cookieName = DEFAULT_COOKIE_NAME): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = getCookieValue(cookieName);
  return value ? value : undefined;
}
