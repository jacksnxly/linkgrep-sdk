// Structured-log formatting for Linkgrep errors. Centralized here so the
// @linkgrep/better-auth plugin's built-in onError fallback and any example /
// host integration share a single source of truth for the on-the-wire log
// shape — pre-existing inline formatters had already drifted by one field
// (`docUrl` present in the plugin, absent in the example app — keryx
// 2026-05-23, finding #7).
//
// The shape is deliberately log-line oriented (key=value pairs) so it can be
// grep'd against without a JSON parser, and so Sentry/Datadog/Honeycomb
// scrapers that auto-extract key=value tags pick up the fields. Host apps
// preferring structured JSON should provide their own `onError` callback
// and ignore this helper — see packages/better-auth/src/plugin.ts.

import { LinkgrepError, LinkgrepNetworkError } from "./http/errors.js";

/**
 * Render a LinkgrepError or LinkgrepNetworkError into a single-line
 * structured log entry. Used by the better-auth plugin's onError fallback
 * and by example apps that emit consistent diagnostics across track.lead
 * and track.sale call sites.
 *
 * Output format for LinkgrepError:
 *   `[linkgrep] <prefix> failed: code=<code> status=<status> requestId=<id> docUrl=<url> message=<msg>`
 *
 * Output format for LinkgrepNetworkError:
 *   `[linkgrep] <prefix> transport failure: kind=<kind> message=<msg>`
 *
 * Missing optional fields (`requestId`, `docUrl`) render as `-`.
 *
 * @param prefix call-site identifier (e.g. "track.lead", "track.sale")
 * @param error  the SDK error to format
 */
export function formatTrackError(
  prefix: string,
  error: LinkgrepError | LinkgrepNetworkError,
): string {
  if (error instanceof LinkgrepError) {
    return `[linkgrep] ${prefix} failed: code=${error.code} status=${error.status} requestId=${error.requestId ?? "-"} docUrl=${error.docUrl ?? "-"} message=${error.message}`;
  }
  // LinkgrepNetworkError branch (sealed union; no other arms exist).
  return `[linkgrep] ${prefix} transport failure: kind=${error.kind} message=${error.message}`;
}
