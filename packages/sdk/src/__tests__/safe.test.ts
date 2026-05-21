import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import { Linkgrep, NotFoundError, type Result } from "../index.js";

const BASE = "https://api.linkgrep.app";

describe(".safe() variants", () => {
  it("track.lead.safe returns { ok: true, data } on success", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json({ customerId: "cus_abc" }, { status: 201 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.lead.safe({
      clickId: "click_x",
      eventName: "Sign Up",
      customerExternalId: "u1",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.customerId).toBe("cus_abc");
    }
  });

  it("track.lead.safe returns { ok: false, error } on HTTP error (does NOT throw)", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Click not found", doc_url: "https://x" } },
          { status: 404 },
        ),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.lead.safe({
      clickId: "fake",
      eventName: "Sign Up",
      customerExternalId: "u1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(NotFoundError);
      expect((result.error as NotFoundError).code).toBe("not_found");
      expect(result.error.message).toBe("Click not found");
    }
  });

  it("track.lead.safe wraps network errors as { ok: false, error } (does NOT throw)", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () => {
        return HttpResponse.error(); // simulates network error
      }),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.lead.safe({
      clickId: "x",
      eventName: "Sign Up",
      customerExternalId: "u1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Network errors are NOT LinkgrepError; they are raw Error.
      expect(result.error).toBeInstanceOf(Error);
    }
  });

  it("track.sale.safe returns { ok: true, data } on success", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        HttpResponse.json({ commissionId: "cm_abc", status: "pending" }, { status: 201 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.sale.safe({
      customerExternalId: "u1",
      amount: 9700,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.commissionId).toBe("cm_abc");
    }
  });

  it("track.sale.safe surfaces 409 as { ok: true, data: { duplicate: true } } (NOT an error)", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        new HttpResponse(null, { status: 409 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.sale.safe({
      customerExternalId: "u1",
      amount: 100,
      invoiceId: "inv_dup",
    });

    // 409 dedup is a normal success outcome — the client short-circuits it.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.duplicate).toBe(true);
    }
  });
});

describe("default throwing behavior (throwOnError option removed)", () => {
  it("track.lead throws on HTTP error", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          { error: { code: "not_found", message: "Click not found", doc_url: "https://x" } },
          { status: 404 },
        ),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    await expect(
      linkgrep.track.lead({ clickId: "fake", eventName: "Sign Up", customerExternalId: "u1" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// Type-only smoke: ensure Result is exported as a type from the barrel
const _typeSmoke: Result<{ a: number }> | undefined = undefined;
void _typeSmoke;
