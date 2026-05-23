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

import { LinkgrepError, type LinkgrepNetworkError } from "./http/errors.js";

/**
 * Render a LinkgrepError or LinkgrepNetworkError into a single-line
 * structured log entry. Used by the better-auth plugin's onError fallback
 * and by example apps that emit consistent diagnostics across track.lead
 * and track.sale call sites.
 *
 * Output format for LinkgrepError:
 *   `[linkgrep] <prefix> failed: code=<code> status=<status> requestId="<id>" docUrl="<url>" message="<msg>"`
 *
 * Output format for LinkgrepNetworkError:
 *   `[linkgrep] <prefix> transport failure: kind=<kind> message="<msg>"`
 *
 * Missing optional fields (`requestId`, `docUrl`) render as the bare
 * sentinel `-` (NOT `"-"`) so grep tooling that filters on
 * `requestId=-` continues to work.
 *
 * Every server-controlled string field — `message`, `requestId`, and
 * `docUrl` — is JSON-encoded so embedded `;`, `=`, `"`, and newlines
 * stay inside the quoted string. The fields that ship unquoted (`code`,
 * `status`, `kind`) are SDK-typed: `code` is a literal union (closed
 * set, `KNOWN_ERROR_CODES`); `status` is a number; `kind` is a sealed
 * `LinkgrepNetworkErrorKind` union. They cannot carry server-controlled
 * bytes by construction.
 *
 * Per Grafana Loki's logfmt parser docs
 * (https://grafana.com/docs/loki/latest/query/log_queries/),
 * `key="value in double quotes"` is the canonical valid form for any
 * value containing whitespace or separators; unquoted values containing
 * `=` or extra `=` make the whole pair invalid (`fo"o=bar`,
 * `foo=bar=buzz`). Without this escape, a hostile or compromised
 * upstream returning `doc_url: "https://docs.../foo\nfake_key=val\n
 * message=stolen"` reproduces the exact multi-line / duplicate-tag
 * corruption pattern the original `message`-only fix was written to
 * prevent — proven by Phase B Rung 2 runtime repro under keryx
 * 2026-05-23 issue validation (artifacts at
 * .keryx/validations/artifacts/2026-05-23T1224Z/).
 *
 * Keryx 2026-05-23 review, finding #3 (message escape); 2026-05-23
 * issue validation, finding #1 (extended to requestId + docUrl).
 *
 * @param prefix call-site identifier (e.g. "track.lead", "track.sale")
 * @param error  the SDK error to format
 */
export function formatTrackError(
  prefix: string,
  error: LinkgrepError | LinkgrepNetworkError,
): string {
  if (error instanceof LinkgrepError) {
    const requestId = error.requestId !== undefined ? JSON.stringify(error.requestId) : "-";
    const docUrl = error.docUrl !== undefined ? JSON.stringify(error.docUrl) : "-";
    return `[linkgrep] ${prefix} failed: code=${error.code} status=${error.status} requestId=${requestId} docUrl=${docUrl} message=${JSON.stringify(error.message)}`;
  }
  // LinkgrepNetworkError branch (sealed union; no other arms exist).
  return `[linkgrep] ${prefix} transport failure: kind=${error.kind} message=${JSON.stringify(error.message)}`;
}
