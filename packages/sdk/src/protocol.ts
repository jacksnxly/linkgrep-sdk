// Cross-package protocol constants. These travel over the wire (as cookie
// names, header names, click-ID payloads) between the browser, the proxy,
// and the linkgrep API — so they live in the `linkgrep` SDK alongside
// `ClickId`, not in a single bounded-context package. Both `@linkgrep/
// analytics` (browser writer) and `@linkgrep/better-auth` (server reader)
// import from here.
//
// Keryx review 2026-05-22T1438Z (I-5, I-6): pre-fix, the canonical
// cookie name lived in `@linkgrep/analytics` and `@linkgrep/better-auth`
// had a runtime `dependencies` entry on that browser package to read one
// 7-byte string. The example app + tests then maintained four more
// duplicate string literals. Centralising here cuts the dependency edge
// and makes the constant single-source.

/**
 * Name of the cookie that persists a `ClickId` from query-param capture
 * (`?lg_id=...`) for downstream attribution lookups. Read by both the
 * browser analytics writer and any server-side reader (better-auth
 * plugin, first-party proxy filter).
 */
export const DEFAULT_CLICK_ID_COOKIE = "lgr_id";

/**
 * Validation pattern for click-ID values: URL-safe base62 plus `-_`,
 * bounded length. Used at the analytics entry point to reject inputs
 * that could otherwise inject `;` / `=` / control bytes into the cookie
 * write, and to keep attacker-controllable cookie size bounded.
 */
export const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
