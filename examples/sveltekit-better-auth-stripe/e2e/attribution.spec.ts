import { test, expect } from "@playwright/test";

test.describe("linkgrep attribution flow", () => {
  test("captures lgr_id cookie from ?lg_id= query param", async ({ page }) => {
    await page.goto("/?lg_id=e2e_test_click_123");

    // Wait for the dynamic @linkgrep/analytics import + init() to write the
    // cookie. The cookie API is sync once init runs, but the dynamic import
    // is not — poll instead of sleeping.
    await expect.poll(async () => {
      const cookies = await page.context().cookies();
      return cookies.find(c => c.name === "lgr_id")?.value;
    }).toBe("e2e_test_click_123");
  });

  // NOTE: the assertion "track.lead is called on signup with the captured
  // clickId" — exercising the @linkgrep/better-auth plugin's after-hook —
  // cannot be observed end-to-end via Playwright's `page.route` because the
  // outbound POST originates in the SvelteKit *server* process
  // (better-auth's runInBackground → @linkgrep/sdk → api.linkgrep.app), not
  // in the browser. `page.route` intercepts browser fetches only. The same
  // behavior is verified deterministically at the unit level with MSW Node
  // in packages/better-auth/src/__tests__/plugin.test.ts (6 tests covering
  // sign-up vs sign-in, cookie modes, payload shape). Reproducing it in e2e
  // would require MSW-Node inside the SvelteKit dev server or a fan-out
  // proxy — disproportionate complexity for assertions already covered.
  //
  // The HAPPY-PATH proof we CAN do end-to-end: the form submits and the
  // page redirects to / on success (proves the better-auth route is wired
  // and signup actually creates a user).
  test("signup form submits successfully and redirects to /", async ({ page }) => {
    await page.goto("/?lg_id=e2e_signup_click");
    await page.goto("/signup");
    await page.fill('[name="email"]', `e2e_${Date.now()}@test.com`);
    await page.fill('[name="password"]', "password123");

    await Promise.all([
      page.waitForURL("**/", { timeout: 15_000 }),
      page.click('button[type="submit"]'),
    ]);

    // On success the signup page navigates to "/" — confirms the better-auth
    // route accepted the credentials and created a session. The track.lead
    // server-side call (and its payload shape) is covered by unit tests.
    expect(page.url()).toMatch(/\/$/);
  });

  // Regression for keryx Important #2 (validated 2026-05-22): /lgr's 64 KiB
  // request-body cap MUST hold even when the client uses Transfer-Encoding:
  // chunked (no Content-Length). Pre-fix, the cap was a Content-Length
  // pre-flight only and a chunked body bypassed it. Either a 413 response
  // or a connection-reset (server closed mid-write after deciding to refuse)
  // is acceptable proof the proxy did NOT forward the oversize body upstream.
  test("rejects oversize CHUNKED body upload to /lgr (#2)", async () => {
    const http = await import("node:http");
    const result: { kind: string; status?: number; code?: string } = await new Promise((resolve) => {
      const req = http.request({
        hostname: "localhost",
        port: 5173,
        method: "POST",
        path: "/lgr/api/track/lead",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      });
      let settled = false;
      const settle = (r: { kind: string; status?: number; code?: string }) => {
        if (!settled) { settled = true; resolve(r); }
      };
      req.on("response", res => {
        res.on("data", () => { /* drain */ });
        res.on("end", () => settle({ kind: "response", status: res.statusCode }));
      });
      req.on("error", (e: NodeJS.ErrnoException) => settle({ kind: "socket-error", code: e.code }));
      // Stream 80 KiB in 8 KiB chunks
      const body = "x".repeat(8 * 1024);
      let written = 0;
      const writeNext = () => {
        if (written >= 80 * 1024) { try { req.end(); } catch { /* socket closed */ } return; }
        try { req.write(body); } catch { return; }
        written += 8 * 1024;
        setImmediate(writeNext);
      };
      writeNext();
    });

    const refused =
      (result.kind === "response" && result.status === 413) ||
      (result.kind === "socket-error" && (result.code === "ECONNRESET" || result.code === "EPIPE"));
    expect(refused, `proxy must refuse oversize chunked body (got ${JSON.stringify(result)})`).toBe(true);
  });

  // Regression for keryx #C1: the /lgr proxy must NOT match paths like
  // `/lgr@evil.example/x` or `/lgr-evil.com/y` — those resolve via WHATWG URL
  // grammar to attacker-controlled hosts (userinfo / host-suffix abuse).
  test("does not proxy /lgr-prefix paths that lack a path boundary (#C1)", async ({ request }) => {
    for (const malicious of [
      "/lgr@evil.example/x",
      "/lgr-evil.com/y",
      "/lgrfoo",
    ]) {
      const res = await request.get(malicious, { maxRedirects: 0 });
      // Default SvelteKit `resolve(event)` for an unknown route returns 404.
      // BUG behavior: the request gets routed through the proxy and either
      // succeeds (200/proxy response) or fails open with a 5xx from the
      // outbound fetch — both are NOT 404.
      expect(res.status(), `malicious path leaked into proxy: ${malicious}`).toBe(404);
    }
  });

  // Regression for keryx #I4: /create-checkout must require an authenticated
  // session and must NOT accept lgCustomerExternalId from the request body.
  test("create-checkout refuses unauthenticated requests (#I4)", async ({ request }) => {
    const res = await request.post("/create-checkout", {
      data: { priceId: "price_pro_demo", lgCustomerExternalId: "victim-user-id-spoofed" },
    });
    // Either 401 (correct: unauthenticated) or 400 with a clear "session
    // required" message. NOT 200 with a successful checkout URL.
    expect([401, 403], `unauthenticated checkout returned ${res.status()}`).toContain(res.status());
  });

  test("pricing page POSTs to /create-checkout WITHOUT lgCustomerExternalId in the body", async ({ page }) => {
    // After #I4, the client does NOT send lgCustomerExternalId — the server
    // derives it from the authenticated session. The pricing page just sends
    // { priceId }. Stripe metadata is populated server-side.
    const checkoutRequests: Record<string, unknown>[] = [];
    await page.route("**/create-checkout", async route => {
      checkoutRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ url: "https://checkout.stripe.com/test", lgCustomerExternalId: "u_server_derived" }),
      });
    });

    await page.goto("/pricing");
    // Svelte 5 binds `on:click` during client-side hydration. Without
    // waiting for the hydration JS to land + run, page.click can fire on a
    // not-yet-bound button (no-op) and waitForRequest sees nothing. Wait
    // for networkidle so the dev-server's module graph + hydration JS have
    // settled before clicking. Recommended Playwright pattern for SPAs:
    // https://playwright.dev/docs/api/class-page#page-wait-for-load-state
    await page.waitForLoadState("networkidle");
    await Promise.all([
      page.waitForRequest("**/create-checkout"),
      page.click('[data-plan="pro"]'),
    ]);

    expect(checkoutRequests.length).toBeGreaterThan(0);
    const body = checkoutRequests[0];
    expect(body).toHaveProperty("priceId");
    expect(body, "client must NOT supply lgCustomerExternalId (server-derived)").not.toHaveProperty("lgCustomerExternalId");
  });
});
