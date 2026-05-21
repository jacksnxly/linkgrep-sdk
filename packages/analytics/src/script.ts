import { init, getClickId } from "./core.js";

// Exposed as window.linkgrep when loaded via CDN script tag
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).linkgrep = { init, getClickId };
  // Auto-init if data attributes present on the script tag
  const scriptEl = document.currentScript as HTMLScriptElement | null;
  if (scriptEl) {
    const publishableKey = scriptEl.dataset.publishableKey;
    const apiHost = scriptEl.dataset.apiHost;
    const cookieDomain = scriptEl.dataset.cookieDomain;
    if (publishableKey) init({ publishableKey, apiHost, cookieDomain });
  }
}
