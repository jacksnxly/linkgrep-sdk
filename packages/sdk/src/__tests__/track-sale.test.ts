import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import { Linkgrep } from "../linkgrep.js";

const BASE = "https://api.linkgrep.xyz";

describe("linkgrep.track.sale", () => {
  it("posts to /api/track/sale and returns response", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        HttpResponse.json(
          { commissionId: "cm_abc", commissionAmount: 970, status: "pending" },
          { status: 201 },
        ),
      ),
    );

    const linkgrep = new Linkgrep({ token: "test_key" });
    const result = await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
      currency: "usd",
      invoiceId: "inv_stripe_abc",
    });

    if ("duplicate" in result) throw new Error("expected non-duplicate result");
    expect(result.commissionId).toBe("cm_abc");
    expect(result.status).toBe("pending");
  });

  it("returns { duplicate: true } on 409", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        new HttpResponse(null, { status: 409 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "test_key" });
    const result = await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
    });

    expect("duplicate" in result && result.duplicate).toBe(true);
  });

  it("includes invoiceId as idempotency body field (server keys dedup on this)", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/sale`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ status: "pending" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key" });
    await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
      invoiceId: "inv_stripe_abc123",
    });

    expect(body.invoiceId).toBe("inv_stripe_abc123");
  });

  // Regression for keryx batch-2 #I5+#I8: the previous version of this test
  // asserted body.paymentProcessor / body.eventName === undefined after calling
  // track.sale with only the legal input fields — which TypeScript already
  // forbade at the call site (excess-property check), making the runtime
  // assertion vacuously true. Now that track/sale.ts has an exhaustiveness
  // guard mirroring track/lead.ts, the SDK actively drops extra fields from
  // the wire. Cast through `as TrackSaleInput` to bypass excess-property
  // checking and verify the guard at runtime.
  it("drops extra fields at the wire-translation seam (#I5/#I8 exhaustiveness guard)", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/sale`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ status: "pending" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key" });
    await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
      // These fields are NOT part of TrackSaleInput. Without the
      // destructure-and-restrict seam in track/sale.ts they would flow
      // verbatim to the wire body. The cast simulates a JS consumer or a
      // future type drift; the guard in sale.ts must drop them.
      paymentProcessor: "stripe",
      eventName: "Purchase",
    } as unknown as Parameters<typeof linkgrep.track.sale>[0]);

    expect(body.paymentProcessor, "guard must strip unknown fields").toBeUndefined();
    expect(body.eventName, "guard must strip unknown fields").toBeUndefined();
    // Legal fields still pass through:
    expect(body.customerExternalId).toBe("user_123");
    expect(body.amount).toBe(9700);
  });
});
