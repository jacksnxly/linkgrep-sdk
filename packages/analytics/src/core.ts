import { setCookie, getCookieValue } from "./cookie.js";

export interface LinkgrepAnalyticsOptions {
  publishableKey: string;
  apiHost?: string;
  cookieDomain?: string;
  cookieName?: string;
}

export const DEFAULT_COOKIE_NAME = "lgr_id";
const DEFAULT_MAX_AGE = 90 * 24 * 60 * 60; // 90 days

export function init(opts: LinkgrepAnalyticsOptions): void {
  const params = new URLSearchParams(window.location.search);
  const lgId = params.get("lg_id");
  if (!lgId) return;

  setCookie(opts.cookieName ?? DEFAULT_COOKIE_NAME, lgId, {
    domain: opts.cookieDomain,
    maxAge: DEFAULT_MAX_AGE,
    sameSite: "Lax",
    secure: window.location.protocol === "https:",
  });
}

export function getClickId(cookieName = DEFAULT_COOKIE_NAME): string | undefined {
  const value = getCookieValue(cookieName);
  return value ? value : undefined;
}
