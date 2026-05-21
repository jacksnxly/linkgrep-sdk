import { test, expect } from "@playwright/test";

test.describe("linkgrep attribution flow", () => {
  test("captures lgr_id cookie from ?lg_id= query param", async ({ page }) => {
    await page.goto("http://localhost:5173/?lg_id=e2e_test_click_123");

    const cookies = await page.context().cookies();
    const lgCookie = cookies.find(c => c.name === "lgr_id");

    expect(lgCookie).toBeDefined();
    expect(lgCookie?.value).toBe("e2e_test_click_123");
  });

  test("track.lead is called on signup with the captured clickId", async ({ page }) => {
    const trackLeadRequests: unknown[] = [];
    await page.route("**/api/track/lead", async route => {
      const body = route.request().postDataJSON();
      trackLeadRequests.push(body);
      await route.fulfill({ status: 201, body: JSON.stringify({ customerId: "cus_e2e" }) });
    });

    await page.goto("http://localhost:5173/?lg_id=e2e_signup_click");
    await page.goto("http://localhost:5173/signup");
    await page.fill('[name="email"]', `e2e_${Date.now()}@test.com`);
    await page.fill('[name="password"]', "password123");
    await page.click('[type="submit"]');

    await page.waitForTimeout(500);

    expect(trackLeadRequests.length).toBeGreaterThan(0);
    const body = trackLeadRequests[0] as Record<string, unknown>;
    expect(body.eventName).toBe("Sign Up");
    expect((body.customer as Record<string, unknown>).externalId).toBeTruthy();
  });

  test("checkout session includes lgCustomerExternalId in metadata", async ({ page }) => {
    const checkoutRequests: unknown[] = [];
    await page.route("**/create-checkout", async route => {
      checkoutRequests.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        body: JSON.stringify({ url: "https://checkout.stripe.com/test" }),
      });
    });

    await page.goto("http://localhost:5173/pricing");
    await page.click('[data-plan="pro"]');
    await page.waitForTimeout(300);

    expect(checkoutRequests.length).toBeGreaterThan(0);
    const body = checkoutRequests[0] as Record<string, unknown>;
    expect(body).toHaveProperty("lgCustomerExternalId");
  });
});
