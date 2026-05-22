import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  Linkgrep,
  LinkgrepError,
  LinkgrepNetworkError,
  DEFAULT_CLICK_ID_COOKIE,
  type RetryOptions,
} from "linkgrep";
import { server } from "./msw-server.js";
import { linkgrepAnalytics, matchesPath } from "../plugin.js";

const BASE = "https://api.linkgrep.app";

function createAuth(overrides?: {
  paths?: string[];
  onError?: (e: LinkgrepError | LinkgrepNetworkError) => void;
  retry?: RetryOptions;
}) {
  const linkgrep = new Linkgrep({
    token: "test_key",
    baseUrl: BASE,
    retry: overrides?.retry ?? { maxAttempts: 1 },
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
        cookieName: DEFAULT_CLICK_ID_COOKIE,
        eventName: "Sign Up",
        paths: overrides?.paths ?? ["/sign-up/email"],
        onError: overrides?.onError,
      }),
    ],
  });
}

describe("linkgrepAnalytics plugin", () => {
  // #I13 — Previously `await new Promise(r => setTimeout(r, 100))` was used
  // to wait for better-auth's `runInBackground` flush. On a slow CI runner
  // 100ms can be insufficient (GC pause, cold start) → flake. Replace with
  // `vi.waitFor(...)` which polls the assertion until it passes or times out
  // — the canonical pattern per vitest docs (vitest.dev/api/vi.html).

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

    await vi.waitFor(() => {
      expect(capturedBody.eventName).toBe("Sign Up");
    });
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

    await vi.waitFor(() => {
      expect(capturedBody.mode).toBe("deferred");
    });
    expect(capturedBody.clickId).toBeUndefined();
  });

  it("does not call track.lead on sign-in (existing user)", async () => {
    // `trackHandlerSpy` instruments the MSW handler invocation, not the SDK
    // method. Pre-fix (keryx M-1) this was `vi.fn().mockResolvedValue(...)`
    // — the resolved-value was dead config because the handler returns its
    // own HttpResponse and never reads the spy's return value.
    const trackHandlerSpy = vi.fn();
    server.use(
      http.post(`${BASE}/api/track/lead`, () => {
        trackHandlerSpy();
        return HttpResponse.json({ customerId: "cus_ghi" }, { status: 201 });
      }),
    );

    const auth = createAuth();
    await auth.api.signUpEmail({
      body: { email: "carol@test.com", password: "password123", name: "Carol" },
      headers: new Headers(),
    });
    // Wait for the sign-up's runInBackground track.lead to finish BEFORE
    // mockClear, otherwise an in-flight sign-up call could be miscounted
    // against the sign-in assertion below.
    await vi.waitFor(() => expect(trackHandlerSpy).toHaveBeenCalled());
    trackHandlerSpy.mockClear();

    await auth.api.signInEmail({
      body: { email: "carol@test.com", password: "password123" },
      headers: new Headers({ cookie: "lgr_id=click_new" }),
    });

    // Negative assertion needs a settling delay; vi.waitFor polls for
    // success, so use a small sleep here. This is the one path where a
    // sleep is correct: we are proving the ABSENCE of a side effect.
    await new Promise((r) => setTimeout(r, 100));
    expect(trackHandlerSpy).not.toHaveBeenCalled();
  });
});

describe("I-10: failure path preserves rich LinkgrepError diagnostic", () => {
  it("invokes onError with the full LinkgrepError (code, status, requestId, docUrl)", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        new HttpResponse(
          JSON.stringify({
            error: {
              code: "internal_error",
              message: "downstream attribution service unavailable",
              doc_url: "https://linkgrep.app/docs/errors/internal-error",
            },
          }),
          {
            status: 500,
            headers: { "content-type": "application/json", "x-request-id": "req_abc123" },
          },
        ),
      ),
    );

    const captured: (LinkgrepError | LinkgrepNetworkError)[] = [];
    const auth = createAuth({ onError: (e) => captured.push(e) });
    await auth.api.signUpEmail({
      body: { email: "dan@test.com", password: "password123", name: "Dan" },
      headers: new Headers(),
    });

    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const err = captured[0]!;
    expect(err).toBeInstanceOf(LinkgrepError);
    if (err instanceof LinkgrepError) {
      expect(err.code).toBe("internal_error");
      expect(err.status).toBe(500);
      expect(err.requestId).toBe("req_abc123");
      expect(err.docUrl).toBe("https://linkgrep.app/docs/errors/internal-error");
      expect(err.message).toMatch(/downstream attribution service unavailable/);
    }
  });
});

describe("matchesPath", () => {
  it("matches exact paths", () => {
    expect(matchesPath("/sign-up/email", ["/sign-up/email"])).toBe(true);
    expect(matchesPath("/sign-up/email/x", ["/sign-up/email"])).toBe(false);
  });

  it("matches prefix paths ending in slash", () => {
    expect(matchesPath("/callback/google", ["/callback/"])).toBe(true);
    expect(matchesPath("/callback/github", ["/callback/"])).toBe(true);
    expect(matchesPath("/callback", ["/callback/"])).toBe(false);
  });

  it("does not match unrelated paths", () => {
    expect(matchesPath("/sign-in/email", ["/sign-up/email", "/callback/"])).toBe(false);
  });
});
