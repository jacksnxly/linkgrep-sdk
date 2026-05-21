import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import {
  Linkgrep,
  LinkgrepError,
  BadRequestError,
  AuthenticationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalServerError,
} from "../index.js";

const BASE = "https://api.linkgrep.app";

describe("error parsing", () => {
  function makeClient() {
    return new Linkgrep({ token: "test_key", throwOnError: true, baseUrl: BASE });
  }

  it("parses linkgrep nested envelope {error: {code, message, doc_url}}", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          {
            error: {
              code: "not_found",
              message: "Click not found",
              doc_url: "https://linkgrep.xyz/docs/api-reference/errors#not-found",
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
      expect(e.docUrl).toBe("https://linkgrep.xyz/docs/api-reference/errors#not-found");
    }
  });

  it("maps each documented status to its subclass", { timeout: 30000 }, async () => {
    const cases: Array<[number, new (...args: never[]) => LinkgrepError, string]> = [
      [400, BadRequestError, "bad_request"],
      [401, AuthenticationError, "unauthorized"],
      [404, NotFoundError, "not_found"],
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
        await linkgrep.track.lead({ clickId: "fake", eventName: "Sign Up", customerExternalId: "u1" });
        throw new Error(`Expected throw for status ${status}`);
      } catch (err) {
        expect(err).toBeInstanceOf(Ctor);
        expect((err as LinkgrepError).status).toBe(status);
        expect((err as LinkgrepError).code).toBe(code);
      }
    }
  });

  it("RateLimitError exposes retryAfter from response headers", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "Slow down", doc_url: "" } },
          { status: 429, headers: { "retry-after": "42" } },
        ),
      ),
    );

    const linkgrep = makeClient();
    try {
      await linkgrep.track.lead({ clickId: "fake", eventName: "Sign Up", customerExternalId: "u1" });
      throw new Error("Expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(42);
    }
  });

  it("falls back to RFC 9457 problem+json shape when Content-Type signals it", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
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
      await linkgrep.track.lead({ clickId: "fake", eventName: "Sign Up", customerExternalId: "u1" });
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
      await linkgrep.track.lead({ clickId: "fake", eventName: "Sign Up", customerExternalId: "u1" });
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

  it("exposes raw body and headers on every error", async () => {
    const rawBody = { error: { code: "conflict", message: "Already tracked", doc_url: "https://x" } };
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        HttpResponse.json(rawBody, { status: 409, headers: { "x-request-id": "req_abc123" } }),
      ),
    );

    // We can't trigger a 409 via the SDK's normal happy-path because HttpClient short-circuits
    // 409 to { duplicate: true } before throwing. To exercise the parser here, call POST directly:
    // Easier: confirm via a 400 with extra headers.
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
      await linkgrep.track.lead({ clickId: "fake", eventName: "Sign Up", customerExternalId: "u1" });
      throw new Error("Expected throw");
    } catch (err) {
      const e = err as LinkgrepError;
      expect(e.requestId).toBe("req_lead_001");
      expect((e.raw as { error: { message: string } }).error.message).toBe("bad");
      expect(e.headers.get("x-request-id")).toBe("req_lead_001");
    }
  });
});
