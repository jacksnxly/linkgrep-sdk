import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import { Linkgrep } from "../linkgrep.js";

const BASE = "https://api.linkgrep.app";

describe("linkgrep.track.lead", () => {
  it("posts to /api/track/lead and returns response", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json(
          { customerId: "cus_abc123", clickId: "click_xyz" },
          { status: 201 },
        ),
      ),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    const result = await linkgrep.track.lead({
      clickId: "click_xyz",
      eventName: "Sign Up",
      customerExternalId: "user_123",
    });

    expect(result.customerId).toBe("cus_abc123");
  });

  it("returns { duplicate: true } on 409 without throwing", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        new HttpResponse(null, { status: 409 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    const result = await linkgrep.track.lead({
      eventName: "Sign Up",
      customerExternalId: "user_123",
    });

    expect(result.duplicate).toBe(true);
  });

  it("translates flat customer fields into nested customer object on the wire", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_abc" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    await linkgrep.track.lead({
      clickId: "click_xyz",
      eventName: "Sign Up",
      customerExternalId: "user_123",
      customerEmail: "jane@test.com",
      customerName: "Jane",
    });

    expect(body.customer).toEqual({
      externalId: "user_123",
      email: "jane@test.com",
      name: "Jane",
    });
    // Flat fields must NOT appear on the wire — they would be silently dropped by Zod.
    expect(body.customerExternalId).toBeUndefined();
    expect(body.customerEmail).toBeUndefined();
    expect(body.customerName).toBeUndefined();
  });

  it("omits clickId from body when mode is deferred", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_abc" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    await linkgrep.track.lead({
      eventName: "Sign Up",
      customerExternalId: "user_123",
      mode: "deferred",
    });

    expect(body.clickId).toBeUndefined();
    expect(body.mode).toBe("deferred");
  });

  it("defaults mode to 'fire-and-forget' (server-accepted value, not 'async')", async () => {
    let body: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        body = await request.json() as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_abc" }, { status: 201 });
      }),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: true });
    await linkgrep.track.lead({
      clickId: "click_xyz",
      eventName: "Sign Up",
      customerExternalId: "user_123",
    });

    expect(body.mode).toBe("fire-and-forget");
  });

  it("does not throw on 500 when throwOnError is false", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "test_key", throwOnError: false });
    await expect(
      linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "user_123" })
    ).resolves.toBeDefined();
  });
});
