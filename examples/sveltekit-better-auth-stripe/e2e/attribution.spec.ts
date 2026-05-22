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

  test("track.lead is called on signup with the captured clickId", async ({ page }) => {
    const trackLeadRequests: Record<string, unknown>[] = [];
    await page.route("**/api/track/lead", async route => {
      trackLeadRequests.push(route.request().postDataJSON());
      await route.fulfill({ status: 201, body: JSON.stringify({ customerId: "cus_e2e" }) });
    });

    await page.goto("/?lg_id=e2e_signup_click");
    await page.goto("/signup");
    await page.fill('[name="email"]', `e2e_${Date.now()}@test.com`);
    await page.fill('[name="password"]', "password123");

    // Init the listener BEFORE the action that triggers the request, then
    // await both together — Playwright network docs canonical pattern.
    await Promise.all([
      page.waitForRequest("**/api/track/lead"),
      page.click('button[type="submit"]'),
    ]);

    expect(trackLeadRequests.length).toBeGreaterThan(0);
    const body = trackLeadRequests[0];
    expect(body.eventName).toBe("Sign Up");
    expect((body.customer as Record<string, unknown>).externalId).toBeTruthy();
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

  test("checkout session includes lgCustomerExternalId in metadata", async ({ page }) => {
    const checkoutRequests: Record<string, unknown>[] = [];
    await page.route("**/create-checkout", async route => {
      checkoutRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ url: "https://checkout.stripe.com/test" }),
      });
    });

    await page.goto("/pricing");
    await Promise.all([
      page.waitForRequest("**/create-checkout"),
      page.click('[data-plan="pro"]'),
    ]);

    expect(checkoutRequests.length).toBeGreaterThan(0);
    const body = checkoutRequests[0];
    expect(body).toHaveProperty("lgCustomerExternalId");
  });
});
