import { init, getClickId, type LinkgrepBrowserAnalyticsOptions } from "./core.js";

declare global {
  interface Window {
    linkgrep?: { init: typeof init; getClickId: typeof getClickId };
  }
}

// Exposed as window.linkgrep when loaded via CDN script tag.
if (typeof window !== "undefined") {
  window.linkgrep = { init, getClickId };
  // Auto-init on script load. Optional config via data-* on the script tag.
  const scriptEl = document.currentScript as HTMLScriptElement | null;
  const opts: LinkgrepBrowserAnalyticsOptions = {};
  if (scriptEl?.dataset.cookieDomain) opts.cookieDomain = scriptEl.dataset.cookieDomain;
  if (scriptEl?.dataset.cookieName) opts.cookieName = scriptEl.dataset.cookieName;
  init(opts);
}
