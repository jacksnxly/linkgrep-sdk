import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  InternalServerError,
  Linkgrep,
  LinkgrepNetworkError,
  NotFoundError,
  type Result,
} from "../index.js";
import { server } from "./msw-server.js";

const BASE = "https://api.linkgrep.xyz";

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
      if ("duplicate" in result.data) throw new Error("expected non-duplicate result");
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

  it("track.lead.safe wraps network errors as LinkgrepNetworkError (does NOT throw)", async () => {
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
      // Network failures are now surfaced as a tagged LinkgrepNetworkError
      // so consumers can discriminate timeout / abort / network via .kind
      // (#I10 — previously the type was `LinkgrepError | Error` and the only
      // way to narrow was string-sniff err.name).
      expect(result.error).toBeInstanceOf(LinkgrepNetworkError);
      if (result.error instanceof LinkgrepNetworkError) {
        expect(result.error.kind).toBe("network");
      }
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
      if ("duplicate" in result.data) throw new Error("expected non-duplicate result");
      expect(result.data.commissionId).toBe("cm_abc");
    }
  });

  it("track.sale.safe surfaces 409 as { ok: true, data: { duplicate: true } } (NOT an error)", async () => {
    server.use(http.post(`${BASE}/api/track/sale`, () => new HttpResponse(null, { status: 409 })));

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.sale.safe({
      customerExternalId: "u1",
      amount: 100,
      invoiceId: "inv_dup",
    });

    // 409 dedup is a normal success outcome — the client short-circuits it.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("duplicate" in result.data && result.data.duplicate).toBe(true);
    }
  });

  // Backfill (keryx C8): track.sale.safe previously had only success and
  // 409-dedup coverage. Mirror the lead.safe HTTP-error + network-error
  // tests so a future refactor that inverts Result polarity on sale would
  // be caught by the same shape as lead.
  it("track.sale.safe returns { ok: false, error } on HTTP error (does NOT throw)", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        HttpResponse.json(
          { error: { code: "internal_error", message: "boom", doc_url: "https://x" } },
          { status: 500 },
        ),
      ),
    );

    const linkgrep = new Linkgrep({
      token: "k",
      baseUrl: BASE,
      // Disable retry so the 500 surfaces immediately; retry semantics are
      // covered in retry.test.ts.
      retry: { maxAttempts: 1 },
    });
    const result = await linkgrep.track.sale.safe({
      customerExternalId: "u1",
      amount: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(InternalServerError);
      expect((result.error as InternalServerError).status).toBe(500);
    }
  });

  it("track.sale.safe wraps network errors as LinkgrepNetworkError (does NOT throw)", async () => {
    server.use(http.post(`${BASE}/api/track/sale`, () => HttpResponse.error()));

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.sale.safe({
      customerExternalId: "u1",
      amount: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(LinkgrepNetworkError);
      if (result.error instanceof LinkgrepNetworkError) {
        expect(result.error.kind).toBe("network");
      }
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

// Regression for keryx batch-2 #I10: LinkgrepNetworkError.from() must
// classify the underlying transport failure into the right tagged kind so
// consumers can branch on `error.kind`.
describe("LinkgrepNetworkError discriminator", () => {
  it("classifies AbortError → kind: 'abort'", () => {
    const err = LinkgrepNetworkError.from(new DOMException("user cancelled", "AbortError"));
    expect(err.kind).toBe("abort");
  });
  it("classifies TimeoutError → kind: 'timeout'", () => {
    const err = LinkgrepNetworkError.from(new DOMException("timed out", "TimeoutError"));
    expect(err.kind).toBe("timeout");
  });
  it("classifies anything else → kind: 'network'", () => {
    const err = LinkgrepNetworkError.from(new TypeError("fetch failed"));
    expect(err.kind).toBe("network");
  });
});

// Type-only smoke: ensure Result is exported as a type from the barrel
const _typeSmoke: Result<{ a: number }> | undefined = undefined;
void _typeSmoke;
