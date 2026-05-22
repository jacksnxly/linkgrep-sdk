export { init, getClickId } from "./core.js";
// Re-export the canonical cookie name from the SDK so consumers of
// @linkgrep/analytics don't need to also depend on `linkgrep` for it.
export { DEFAULT_CLICK_ID_COOKIE } from "linkgrep";
export type { LinkgrepBrowserAnalyticsOptions } from "./core.js";
