import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Linkgrep, LinkgrepError, type LinkgrepNetworkError, type RetryOptions } from "linkgrep";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { linkgrepAnalytics } from "../plugin.js";
import { server } from "./msw-server.js";

const BASE = "https://api.linkgrep.xyz";

function createAuth(overrides?: {
  requireEmailVerification?: boolean;
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
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: overrides?.requireEmailVerification ?? false,
    },
    plugins: [
      // `cookieName` intentionally omitted (keryx issue #8, 2026-05-23) so
      // these tests exercise the plugin's default-fallback path. The
      // plugin defaults to `DEFAULT_CLICK_ID_COOKIE` from the SDK's
      // `protocol.ts` — passing it explicitly here would re-introduce the
      // pass-through-redundancy the validation surfaced.
      linkgrepAnalytics({
        client: linkgrep,
        eventName: "Sign Up",
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

  it("fires track.lead on sign-up even when requireEmailVerification leaves the user session-less", async () => {
    // REGRESSION — the production bug this plugin redesign fixes
    // (athenum referral system, 2026-06: 908 clicks / 0 leads ever).
    //
    // Pre-fix, the plugin was an `after`-hook path matcher gated on
    // `ctx.context.newSession?.user`. A host app with
    // `emailAndPassword.requireEmailVerification: true` creates the user
    // WITHOUT a session (better-auth dist/api/routes/sign-up.mjs:
    // `shouldSkipAutoSignIn` → `{ token: null, user }`), so the gate
    // bailed and `track.lead` never fired — for ANY credential signup.
    //
    // The fix follows Dub's official better-auth integration
    // (github.com/dubinc/dub-better-auth src/index.ts): attribution moves
    // to `databaseHooks.user.create.after`, gated only on the click
    // cookie. User creation is the lead event; no session required.
    let capturedBody: Record<string, unknown> = {};

    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_nosess" }, { status: 201 });
      }),
    );

    const auth = createAuth({ requireEmailVerification: true });
    const result = await auth.api.signUpEmail({
      body: { email: "eve@test.com", password: "password123", name: "Eve" },
      headers: new Headers({ cookie: "lgr_id=click_nosession" }),
    });

    // Precondition for the regression to be meaningful: no session was
    // created. If better-auth ever changes this, the test must be
    // re-evaluated rather than silently passing through the session path.
    expect(result.token).toBeNull();

    await vi.waitFor(() => {
      expect(capturedBody.clickId).toBe("click_nosession");
    });
    expect(capturedBody.eventName).toBe("Sign Up");
    expect(capturedBody.customer).toMatchObject({
      externalId: expect.any(String),
      email: "eve@test.com",
      name: "Eve",
    });
    expect(capturedBody.mode).toBe("fire-and-forget");
  });

  it("does NOT call track.lead when the click cookie is absent (non-referred signup ships no PII)", async () => {
    // Design change vs the pre-2026-06 plugin: previously a cookie-less
    // signup fired a "deferred"-mode lead, shipping email + name + UUID
    // for EVERY signup. Dub-aligned semantics: the click cookie IS the
    // referral signal — without it there is nothing to attribute, so no
    // request leaves the host app at all.
    const trackHandlerSpy = vi.fn();
    let capturedBody: Record<string, unknown> = {};
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        trackHandlerSpy();
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ customerId: "cus_def" }, { status: 201 });
      }),
    );

    const auth = createAuth();
    await auth.api.signUpEmail({
      body: { email: "bob@test.com", password: "password123", name: "Bob" },
      headers: new Headers(),
    });

    // Fence pattern (keryx issue #4, 2026-05-23): a fixed sleep cannot
    // prove absence. Perform a KNOWN-DISPATCHING signup (with cookie)
    // AFTER the cookie-less one, wait for the fence's dispatch, then
    // assert the spy fired exactly once — the fence only.
    await auth.api.signUpEmail({
      body: { email: "fence@test.com", password: "password123", name: "Fence" },
      headers: new Headers({ cookie: "lgr_id=click_fence" }),
    });
    await vi.waitFor(() => expect(trackHandlerSpy).toHaveBeenCalledTimes(1));
    expect(capturedBody.clickId, "the only dispatch must be the cookie-carrying fence signup").toBe(
      "click_fence",
    );
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
      headers: new Headers({ cookie: "lgr_id=click_carol" }),
    });
    // Wait for the sign-up's track.lead to finish BEFORE mockClear,
    // otherwise an in-flight sign-up call could be miscounted against the
    // sign-in assertion below.
    await vi.waitFor(() => expect(trackHandlerSpy).toHaveBeenCalled());
    trackHandlerSpy.mockClear();

    await auth.api.signInEmail({
      body: { email: "carol@test.com", password: "password123" },
      headers: new Headers({ cookie: "lgr_id=click_new" }),
    });

    // Fence pattern (keryx issue #4, 2026-05-23): a fixed 100 ms sleep
    // cannot PROVE absence — only "absence within 100 ms". The
    // deterministic fix is to perform a KNOWN-DISPATCHING action (a fresh
    // cookie-carrying sign-up) AFTER the sign-in, then wait for that
    // fence's dispatch via vi.waitFor. By the time the fence resolves,
    // any sign-in–side dispatch would also have had time to fire — so the
    // spy count being exactly 1 (the fence only) is proof the sign-in did
    // not dispatch.
    //
    // Under the databaseHooks design this invariant holds by construction:
    // sign-in performs no user.create, so the hook cannot fire — even
    // though the sign-in request above carries a fresh click cookie.
    await auth.api.signUpEmail({
      body: { email: "dave@test.com", password: "password123", name: "Dave" },
      headers: new Headers({ cookie: "lgr_id=click_dave" }),
    });
    await vi.waitFor(() => expect(trackHandlerSpy).toHaveBeenCalledTimes(1));
    expect(
      trackHandlerSpy,
      "sign-in must NOT dispatch track.lead — fence proves the only dispatch came from the post-sign-in sign-up",
    ).toHaveBeenCalledTimes(1);
  });
});

describe("I-10: failure path preserves rich LinkgrepError diagnostic", () => {
  it("invokes onError with the full LinkgrepError (code, status, requestId, docUrl)", async () => {
    server.use(
      http.post(
        `${BASE}/api/track/lead`,
        () =>
          new HttpResponse(
            JSON.stringify({
              error: {
                code: "internal_error",
                message: "downstream attribution service unavailable",
                doc_url: "https://docs.linkgrep.xyz/errors/internal-error",
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
      headers: new Headers({ cookie: "lgr_id=click_dan" }),
    });

    await vi.waitFor(() => expect(captured.length).toBeGreaterThan(0));
    const err = captured[0]!;
    expect(err).toBeInstanceOf(LinkgrepError);
    if (err instanceof LinkgrepError) {
      expect(err.code).toBe("internal_error");
      expect(err.status).toBe(500);
      expect(err.requestId).toBe("req_abc123");
      expect(err.docUrl).toBe("https://docs.linkgrep.xyz/errors/internal-error");
      expect(err.message).toMatch(/downstream attribution service unavailable/);
    }
  });
});
