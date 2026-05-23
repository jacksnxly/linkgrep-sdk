// Regression for keryx 2026-05-23 review, finding #7: structured-log
// drift between the @linkgrep/better-auth plugin's onError fallback and
// the example app's logTrackError helper. Pre-fix the example dropped
// `docUrl` while claiming to mirror the plugin's shape. Both call sites
// now route through the SDK's canonical `formatTrackError` helper, so
// this test pins the shape — adding / renaming / dropping a field here
// is the explicit decision-point for both consumers simultaneously.
import { describe, expect, it } from "vitest";
import {
  formatTrackError,
  LinkgrepError,
  LinkgrepNetworkError,
} from "../index.js";

describe("formatTrackError — single-source structured-log shape", () => {
  it("LinkgrepError emits code / status / requestId / docUrl / message", () => {
    const err = new LinkgrepError({
      status: 422,
      code: "unprocessable",
      message: "amount must be > 0",
      docUrl: "https://docs.linkgrep.xyz/errors/unprocessable",
      requestId: "req_abc123",
      raw: null,
      headers: new Headers(),
    });
    expect(formatTrackError("track.sale", err)).toBe(
      "[linkgrep] track.sale failed: code=unprocessable status=422 requestId=req_abc123 docUrl=https://docs.linkgrep.xyz/errors/unprocessable message=\"amount must be > 0\"",
    );
  });

  it("LinkgrepError missing optional fields renders them as `-`", () => {
    const err = new LinkgrepError({
      status: 500,
      code: "internal_error",
      message: "boom",
      raw: null,
      headers: new Headers(),
    });
    expect(formatTrackError("track.lead", err)).toBe(
      "[linkgrep] track.lead failed: code=internal_error status=500 requestId=- docUrl=- message=\"boom\"",
    );
  });

  it("LinkgrepNetworkError emits kind / message", () => {
    const err = new LinkgrepNetworkError("timeout", "request budget exhausted");
    expect(formatTrackError("track.lead", err)).toBe(
      "[linkgrep] track.lead transport failure: kind=timeout message=\"request budget exhausted\"",
    );
  });

  // Regression for keryx 2026-05-23 review, finding #3: pre-fix the
  // `message` value was template-interpolated verbatim. A server returning
  // `"missing field; eventName=fake\nuser=victim"` produced output that
  // logfmt scrapers (Sentry / Datadog / Honeycomb / Grafana Loki) would
  // parse as multiple top-level keys, with the embedded `eventName=fake`
  // overriding the call's actual eventName tag, and the embedded `\n`
  // breaking the documented "single-line" guarantee.
  //
  // Grafana Loki documents the logfmt contract verbatim: valid pairs
  // include `key="value in double quotes"`; an unquoted value containing
  // separators (`fo"o=bar`, `foo=bar=buzz`) is invalid. Fix: always quote
  // the message via JSON.stringify so embedded `;`, `=`, `"`, and newlines
  // stay inside the quoted string.
  //   https://grafana.com/docs/loki/latest/query/log_queries/
  describe("logfmt safety — defends the single-source-of-truth contract", () => {
    it("escapes embedded newlines and key=value separators in error.message", () => {
      const originalMessage = "missing field; eventName=fake\nuser=victim";
      const err = new LinkgrepError({
        status: 400,
        code: "bad_request",
        message: originalMessage,
        raw: null,
        headers: new Headers(),
      });
      const line = formatTrackError("track.lead", err);
      // Single-line guarantee: the embedded `\n` must NOT escape into the
      // output as a real newline.
      expect((line.match(/\n/g) || []).length, "log line must remain single-line").toBe(0);
      // Structural integrity: exactly one `message=` token, and its value
      // is a JSON-encoded string that round-trips to the original. This is
      // the canonical proof that scrapers cannot mis-parse embedded
      // `eventName=` / `user=` as foreign top-level tags — they sit inside
      // the quoted string per the logfmt spec.
      expect((line.match(/message=/g) || []).length, "exactly one message= token").toBe(1);
      const messageValue = line.slice(line.indexOf("message=") + "message=".length);
      expect(JSON.parse(messageValue)).toBe(originalMessage);
    });

    it("escapes embedded quotes in error.message without breaking the surrounding pair", () => {
      const err = new LinkgrepError({
        status: 422,
        code: "unprocessable",
        message: 'expected "active" got "deleted"',
        raw: null,
        headers: new Headers(),
      });
      const line = formatTrackError("track.lead", err);
      // The line must remain parseable as logfmt — exactly one message= token.
      expect((line.match(/message=/g) || []).length).toBe(1);
      // JSON-string escape preserves the inner content under JSON.parse.
      const messageValue = line.slice(line.indexOf("message=") + "message=".length);
      expect(JSON.parse(messageValue)).toBe('expected "active" got "deleted"');
    });

    it("escapes LinkgrepNetworkError.message symmetrically with LinkgrepError", () => {
      const originalMessage = "DNS failure; trace=foo\nstack=bar";
      const err = new LinkgrepNetworkError("network", originalMessage);
      const line = formatTrackError("track.sale", err);
      expect((line.match(/\n/g) || []).length, "single-line").toBe(0);
      expect((line.match(/message=/g) || []).length, "exactly one message= token").toBe(1);
      const messageValue = line.slice(line.indexOf("message=") + "message=".length);
      expect(JSON.parse(messageValue)).toBe(originalMessage);
    });
  });

  // Regression for keryx 2026-05-23 main review (validation report
  // 2026-05-23T1224Z), finding #1: pre-fix the `message` branch was
  // JSON-encoded but the adjacent `requestId` and `docUrl` tokens shipped
  // unquoted. The original commit 22b9446 justified this as "URL-safe
  // contract" — trusting the upstream Linkgrep server to send
  // RFC-3986-compliant URLs in `doc_url`. The runtime repro at
  // .keryx/validations/artifacts/2026-05-23T1224Z/ proved that a
  // hostile / compromised / buggy upstream returning a `doc_url` with an
  // embedded `\n` reproduces the EXACT logfmt-corruption pattern the
  // `message` fix exists to prevent (\n-count=2, message=-count=2 — both
  // invariants violated). The threat model expands: do not trust any
  // server-controlled byte in log output, even ones nominally URL-shaped.
  describe("logfmt safety — hostile docUrl / requestId", () => {
    it("escapes embedded newlines and injected message= in error.docUrl", () => {
      const hostileDocUrl =
        "https://docs.linkgrep.xyz/foo\nfake_key=val\nmessage=stolen";
      const err = new LinkgrepError({
        status: 400,
        code: "bad_request",
        message: "real error",
        requestId: "req_xyz",
        docUrl: hostileDocUrl,
        raw: null,
        headers: new Headers(),
      });
      const line = formatTrackError("track.lead", err);
      // Single-line guarantee must survive a hostile docUrl too.
      expect((line.match(/\n/g) || []).length, "single-line").toBe(0);
      // Exactly one `message=` token — the injected `message=stolen`
      // payload must not surface as a foreign top-level tag.
      expect((line.match(/message=/g) || []).length, "exactly one message=").toBe(1);
      // Round-trip: docUrl is a JSON string carrying the verbatim original.
      const docUrlValue = line.match(/docUrl=("(?:[^"\\]|\\.)*")/)?.[1];
      expect(docUrlValue, "docUrl is JSON-quoted").toBeDefined();
      expect(JSON.parse(docUrlValue!)).toBe(hostileDocUrl);
    });

    it("escapes embedded `=` and `\"` in error.requestId", () => {
      // HTTP/1.1 + HTTP/2 forbid `\n` in header values (RFC 9110 §5.5)
      // so the realistic requestId attack vector is `=` and `"`, not `\n`.
      const hostileRequestId = 'req"abc=injected';
      const err = new LinkgrepError({
        status: 400,
        code: "bad_request",
        message: "real error",
        requestId: hostileRequestId,
        docUrl: "https://docs.linkgrep.xyz/ok",
        raw: null,
        headers: new Headers(),
      });
      const line = formatTrackError("track.lead", err);
      // No stray quoted-pair breakage — exactly one `message=` token,
      // and `requestId=` value round-trips under JSON.parse.
      expect((line.match(/message=/g) || []).length).toBe(1);
      const requestIdValue = line.match(/requestId=("(?:[^"\\]|\\.)*")/)?.[1];
      expect(requestIdValue, "requestId is JSON-quoted").toBeDefined();
      expect(JSON.parse(requestIdValue!)).toBe(hostileRequestId);
    });

    it("missing optional fields still render as the bare `-` sentinel", () => {
      // The defensive quoting must NOT introduce surrounding quotes around
      // the `-` placeholder — that would break grep tooling that filters
      // on `requestId=-` to find calls without a request ID.
      const err = new LinkgrepError({
        status: 500,
        code: "internal_error",
        message: "boom",
        raw: null,
        headers: new Headers(),
      });
      const line = formatTrackError("track.lead", err);
      expect(line).toContain("requestId=- ");
      expect(line).toContain("docUrl=- ");
      // Ensure no `requestId="-"` shape leaked through.
      expect(line).not.toMatch(/requestId="-"/);
      expect(line).not.toMatch(/docUrl="-"/);
    });
  });
});
