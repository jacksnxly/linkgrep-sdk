import { setCookie, getCookieValue } from "./cookie.js";

export interface LinkgrepAnalyticsOptions {
  /** Override the linkgrep API host (e.g. for first-party proxy). Reserved; not used by init() yet. */
  apiHost?: string;
  /** Cookie Domain attribute for cross-subdomain attribution (e.g. ".example.com"). */
  cookieDomain?: string;
  /** Override the default cookie name. */
  cookieName?: string;
}

export const DEFAULT_COOKIE_NAME = "lgr_id";
const DEFAULT_MAX_AGE = 90 * 24 * 60 * 60; // 90 days

// Linkgrep click IDs are URL-safe. Validate at the entry point so an attacker
// cannot inject `;` / `=` / control bytes via `?lg_id=` into the cookie write.
// Limit length to keep attacker-controlled cookie size bounded.
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function init(opts: LinkgrepAnalyticsOptions = {}): void {
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
