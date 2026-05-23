import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  BadRequestError,
  GoneError,
  InternalServerError,
  Linkgrep,
  LinkgrepError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UnprocessableEntityError,
} from "../index.js";
import { server } from "./msw-server.js";

const BASE = "https://api.linkgrep.xyz";

describe("error parsing", () => {
  function makeClient() {
    return new Linkgrep({ token: "test_key", baseUrl: BASE });
  }

  it("parses linkgrep nested envelope {error: {code, message, doc_url}}", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          {
            error: {
              code: "not_found",
              message: "Click not found",
              doc_url: "https://docs.linkgrep.xyz/api-reference/errors#not-found",
            },
          },
          { status: 404 },
        ),
      ),
    );

    const linkgrep = makeClient();
    try {
      await linkgrep.track.lead({
        clickId: "fake",
        eventName: "Sign Up",
        customerExternalId: "u1",
      });
      throw new Error("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err).toBeInstanceOf(LinkgrepError);
      const e = err as NotFoundError;
      expect(e.status).toBe(404);
      expect(e.code).toBe("not_found");
      expect(e.message).toBe("Click not found");
      expect(e.docUrl).toBe("https://docs.linkgrep.xyz/api-reference/errors#not-found");
    }
  });

  it("maps each documented status to its subclass", { timeout: 30000 }, async () => {
    // 409 is exercised separately via the .safe() dedup tests — mapConflict
    // (http/errors.ts) catches ConflictError and translates it into
    // { duplicate: true } before it reaches the throwing entry point, so the
    // try/throw shape below does not work for that status. ConflictError is
    // verified at the parseErrorResponse layer transitively through that path.
    const cases: Array<[number, new (...args: never[]) => LinkgrepError, string]> = [
      [400, BadRequestError, "bad_request"],
      [401, AuthenticationError, "unauthorized"],
      // Backfill (keryx C7): 403/410/422 had no instanceof assertion before;
      // a regression that collapsed parseErrorResponse to the base class for
      // these statuses would not have been caught.
      [403, PermissionError, "permission_denied"],
      [404, NotFoundError, "not_found"],
      [410, GoneError, "gone"],
      [422, UnprocessableEntityError, "unprocessable"],
      [429, RateLimitError, "rate_limited"],
      [500, InternalServerError, "internal_error"],
    ];

    for (const [status, Ctor, code] of cases) {
      server.use(
        http.post(`${BASE}/api/track/lead`, () =>
          HttpResponse.json(
            { error: { code, message: `${code} test`, doc_url: "https://example.com/d" } },
            { status },
          ),
        ),
      );

      const linkgrep = makeClient();
      try {
        await linkgrep.track.lead({
          clickId: "fake",
          eventName: "Sign Up",
          customerExternalId: "u1",
        });
        throw new Error(`Expected throw for status ${status}`);
      } catch (err) {
        expect(err).toBeInstanceOf(Ctor);
        expect((err as LinkgrepError).status).toBe(status);
        expect((err as LinkgrepError).code).toBe(code);
      }
    }
  });

  it("RateLimitError exposes retryAfter from response headers", { timeout: 15000 }, async () => {
    // retry-after: 1 keeps total wait small while still exercising the parser.
    // (The full retry loop honors this value per RFC 9110, so larger values
    // would extend the test runtime — see retry.test.ts for that path.)
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "Slow down", doc_url: "" } },
          { status: 429, headers: { "retry-after": "1" } },
        ),
      ),
    );

    const linkgrep = makeClient();
    try {
      await linkgrep.track.lead({
        clickId: "fake",
        eventName: "Sign Up",
        customerExternalId: "u1",
      });
      throw new Error("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(1);
    }
  });

  it("falls back to RFC 9457 problem+json shape when Content-Type signals it", async () => {
    server.use(
      http.post(
        `${BASE}/api/track/lead`,
        () =>
          new HttpResponse(
            JSON.stringify({
              type: "https://example.com/problems/expired-click",
              title: "Click expired",
              detail: "Click is outside the 30-day attribution window",
            }),
            {
              status: 410,
              headers: { "content-type": "application/problem+json" },
            },
          ),
      ),
    );

    const linkgrep = makeClient();
    try {
      await linkgrep.track.lead({
        clickId: "fake",
        eventName: "Sign Up",
        customerExternalId: "u1",
      });
      throw new Error("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LinkgrepError);
      const e = err as LinkgrepError;
      expect(e.status).toBe(410);
      expect(e.message).toBe("Click expired");
      expect(e.docUrl).toBe("https://example.com/problems/expired-click");
    }
  });

  it("falls back to statusText when body is unparseable or unknown shape (does NOT silently accept flat shape)", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        // Flat shape — old (non-server) format. SDK should NOT treat this as a known error envelope.
        HttpResponse.json({ code: "made_up", message: "would-be flat error" }, { status: 503 }),
      ),
    );

    const linkgrep = makeClient();
    try {
      await linkgrep.track.lead({
        clickId: "fake",
        eventName: "Sign Up",
        customerExternalId: "u1",
      });
      throw new Error("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LinkgrepError);
      const e = err as LinkgrepError;
      expect(e.status).toBe(503);
      expect(e.code).toBe("unknown");
      // Service Unavailable from statusText, NOT "would-be flat error" — must not parse flat shape.
      expect(e.message).not.toBe("would-be flat error");
      // But raw is preserved for debugging.
      expect((e.raw as Record<string, unknown>).message).toBe("would-be flat error");
    }
  });

  // Regression for keryx 2026-05-23 review, finding #6: pre-fix the
  // `LinkgrepError` constructor stored the raw `Headers` reference, so
  // (a) a consumer doing `err.headers.set(...)` mutated the SDK's internal
  // state and (b) mutating the source `Headers` AFTER constructing the
  // error also mutated `err.headers`. WHATWG Fetch (per MDN — see
  // https://developer.mozilla.org/en-US/docs/Web/API/Headers/Headers)
  // documents the constructor as: "the new Headers object copies its data
  // from the existing Headers object." Defensive copy at the constructor
  // boundary is the canonical seal.
  it("LinkgrepError.headers is isolated from the source Headers (defensive copy)", () => {
    const src = new Headers({ "x-request-id": "req_real_abc" });
    const err = new LinkgrepError({
      status: 500,
      code: "internal_error",
      message: "boom",
      raw: null,
      headers: src,
    });
    // Sanity: the error carries what the response had at construction time.
    expect(err.headers.get("x-request-id")).toBe("req_real_abc");
    // Identity: the error's Headers must NOT be the same reference.
    expect(err.headers, "headers must not alias the source").not.toBe(src);
    // Source-side isolation: mutating the source after construction must
    // not bleed into the error.
    src.set("x-request-id", "req_via_source_mutation");
    expect(err.headers.get("x-request-id")).toBe("req_real_abc");
    // Sink-side isolation: mutating err.headers must not bleed into source.
    err.headers.set("x-request-id", "req_via_err_mutation");
    expect(src.get("x-request-id")).toBe("req_via_source_mutation");
  });

  it("exposes raw body and headers on every error", async () => {
    // The track/* layer translates 409 to { duplicate: true } via mapConflict
    // (see http/errors.ts), so we exercise the parser with a 400 + headers
    // on the lead endpoint — the only endpoint this test actually invokes.
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          { error: { code: "bad_request", message: "bad", doc_url: "https://x" } },
          { status: 400, headers: { "x-request-id": "req_lead_001" } },
        ),
      ),
    );

    const linkgrep = makeClient();
    try {
      await linkgrep.track.lead({
        clickId: "fake",
        eventName: "Sign Up",
        customerExternalId: "u1",
      });
      throw new Error("Expected throw");
    } catch (err) {
      const e = err as LinkgrepError;
      expect(e.requestId).toBe("req_lead_001");
      expect((e.raw as { error: { message: string } }).error.message).toBe("bad");
      expect(e.headers.get("x-request-id")).toBe("req_lead_001");
    }
  });
});
