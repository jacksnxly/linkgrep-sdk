import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import { Linkgrep } from "../linkgrep.js";

const BASE = "https://api.linkgrep.app";

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

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    const result = await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
      currency: "usd",
      invoiceId: "inv_stripe_abc",
    });

    expect(result.commissionId).toBe("cm_abc");
    expect(result.status).toBe("pending");
  });

  it("returns { duplicate: true } on 409", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () =>
        new HttpResponse(null, { status: 409 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    const result = await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
    });

    expect(result.duplicate).toBe(true);
  });

  it("includes invoiceId as idempotency body field (server keys dedup on this)", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/sale`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ status: "pending" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
      invoiceId: "inv_stripe_abc123",
    });

    expect(body.invoiceId).toBe("inv_stripe_abc123");
  });

  it("does NOT send paymentProcessor or eventName (server rejects unknown fields silently)", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/sale`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ status: "pending" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    await linkgrep.track.sale({
      customerExternalId: "user_123",
      amount: 9700,
    });

    expect(body.paymentProcessor).toBeUndefined();
    expect(body.eventName).toBeUndefined();
  });
});
