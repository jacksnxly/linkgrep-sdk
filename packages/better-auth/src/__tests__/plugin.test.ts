import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Linkgrep } from "linkgrep";
import { server } from "./msw-server.js";
import { linkgrepAnalytics } from "../plugin.js";

const BASE = "https://api.linkgrep.app";

function createAuth(overrides?: { paths?: string[] }) {
  const linkgrep = new Linkgrep({
    token: "test_key",
    throwOnError: true,
    baseUrl: BASE,
  });

  return betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-at-least-32-chars-long-xxxxxx",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      linkgrepAnalytics({
        client: linkgrep,
        cookieName: "lgr_id",
        eventName: "Sign Up",
        paths: overrides?.paths ?? ["/sign-up/email"],
      }),
    ],
  });
}

describe("linkgrepAnalytics plugin", () => {
  it("calls track.lead with nested customer object after email sign-up", async () => {
    let capturedBody: Record<string, unknown> = {};

    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_abc" }, { status: 201 });
      }),
    );

    const auth = createAuth();
    await auth.api.signUpEmail({
      body: { email: "jane@test.com", password: "password123", name: "Jane" },
      headers: new Headers({ cookie: "lgr_id=click_abc123" }),
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(capturedBody.eventName).toBe("Sign Up");
    expect(capturedBody.customer).toMatchObject({
      externalId: expect.any(String),
      email: "jane@test.com",
      name: "Jane",
    });
    expect(capturedBody.clickId).toBe("click_abc123");
    expect(capturedBody.mode).toBe("fire-and-forget");
  });

  it("uses deferred mode when lgr_id cookie is absent", async () => {
    let capturedBody: Record<string, unknown> = {};

    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_def" }, { status: 201 });
      }),
    );

    const auth = createAuth();
    await auth.api.signUpEmail({
      body: { email: "bob@test.com", password: "password123", name: "Bob" },
      headers: new Headers(),
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(capturedBody.mode).toBe("deferred");
    expect(capturedBody.clickId).toBeUndefined();
  });

  it("does not call track.lead on sign-in (existing user)", async () => {
    const trackSpy = vi.fn().mockResolvedValue({ customerId: "cus_ghi" });
    server.use(
      http.post(`${BASE}/api/track/lead`, () => {
        trackSpy();
        return HttpResponse.json({ customerId: "cus_ghi" }, { status: 201 });
      }),
    );

    const auth = createAuth();
    await auth.api.signUpEmail({
      body: { email: "carol@test.com", password: "password123", name: "Carol" },
      headers: new Headers(),
    });
    trackSpy.mockClear();

    await auth.api.signInEmail({
      body: { email: "carol@test.com", password: "password123" },
      headers: new Headers({ cookie: "lgr_id=click_new" }),
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(trackSpy).not.toHaveBeenCalled();
  });
});
