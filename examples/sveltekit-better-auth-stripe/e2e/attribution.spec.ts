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

  // Regression for keryx Critical C-3 (validated 2026-05-22T1455Z): the
  // /lgr proxy MUST cut off a slowloris client that drips bytes slowly. The
  // body-buffering step must run UNDER the same UPSTREAM_TIMEOUT_MS window
  // as the upstream fetch; pre-fix, the AbortController + timer were
  // wired AFTER readBodyWithCap returned, so a chunked client trickling 1
  // byte every N ms held a SvelteKit server slot until the platform's idle
  // timeout (tens of seconds to minutes). Acceptance: server cuts off the
  // connection (504 or ECONNRESET) within ~UPSTREAM_TIMEOUT_MS + slack.
  test("cuts off slowloris chunked body upload to /lgr within upstream-timeout window (C-3)", async () => {
    const http = await import("node:http");
    const DRIP_INTERVAL_MS = 1500;
    const HARD_DEADLINE_MS = 15_000; // upstream timeout is 10s; this is comfortable headroom
    const start = Date.now();
    const result: { kind: string; cutoffMs: number; status?: number; code?: string } = await new Promise((resolve) => {
      const req = http.request({
        hostname: "localhost",
        port: 5173,
        method: "POST",
        path: "/lgr/api/track/lead",
        headers: { "content-type": "application/json", "transfer-encoding": "chunked" },
      });
      let settled = false;
      const settle = (r: { kind: string; cutoffMs: number; status?: number; code?: string }) => {
        if (!settled) { settled = true; resolve(r); }
      };
      req.on("response", (res) => {
        res.on("data", () => { /* drain */ });
        res.on("end", () => settle({ kind: "response", cutoffMs: Date.now() - start, status: res.statusCode }));
      });
      req.on("error", (e: NodeJS.ErrnoException) => settle({ kind: "socket-error", cutoffMs: Date.now() - start, code: e.code }));
      // Drip 1 byte every DRIP_INTERVAL_MS. With UPSTREAM_TIMEOUT_MS=10s
      // the server should cut us off around the 10s mark.
      const dripper = setInterval(() => {
        try { req.write("x"); } catch { clearInterval(dripper); }
      }, DRIP_INTERVAL_MS);
      const hardKill = setTimeout(() => {
        clearInterval(dripper);
        settle({ kind: "hard-deadline", cutoffMs: HARD_DEADLINE_MS });
        try { req.destroy(); } catch { /* */ }
      }, HARD_DEADLINE_MS);
      req.on("close", () => {
        clearInterval(dripper);
        clearTimeout(hardKill);
      });
    });

    const cutOffInTime =
      (result.kind === "response" && (result.status === 504 || result.status === 413)) ||
      (result.kind === "socket-error" && (result.code === "ECONNRESET" || result.code === "EPIPE"));
    expect(cutOffInTime, `proxy must cut off slowloris within ~UPSTREAM_TIMEOUT_MS (got ${JSON.stringify(result)})`).toBe(true);
    expect(result.cutoffMs, `cut-off must happen well before hard deadline ${HARD_DEADLINE_MS}ms; got ${result.cutoffMs}ms`).toBeLessThan(HARD_DEADLINE_MS - 500);
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

  // Regression for keryx I-9 (validated 2026-05-22T1455Z): the example
  // app must demonstrate the full attribution loop, including the
  // Stripe-webhook -> track.sale step. The webhook endpoint must:
  //   - exist (the entire premise of the example app)
  //   - reject unsigned requests with a clear 400 (signature verification)
  //   - not crash when STRIPE_WEBHOOK_SECRET is unset (returns 400, not 500)
  test("/api/stripe-webhook rejects unsigned POSTs with 400 (#I-9)", async ({ request }) => {
    const res = await request.post("/api/stripe-webhook", {
      data: { type: "checkout.session.completed" },
      headers: { "content-type": "application/json" },
    });
    // 400 because the Stripe-Signature header is missing OR because the
    // STRIPE_WEBHOOK_SECRET is not configured. Either way the endpoint
    // exists, refuses unsigned events, and does not crash.
    expect(res.status(), `webhook must exist + refuse unsigned events; got ${res.status()}`).toBe(400);
  });

  // Regression for keryx issue #1 (validated 2026-05-23): per Stripe's
  // official guidance (https://docs.stripe.com/webhooks — "Quickly return
  // a 2xx response ... prior to any complex logic that might cause a
  // timeout"), the handler MUST NOT `await` `track.sale.safe(...)`
  // before the 200 ack. Awaiting under default SDK retry knobs
  // (maxAttempts=3 × timeoutMs=10_000 + backoffs ≈ 33 s under
  // degraded-but-not-dead upstream) would exceed Stripe's documented
  // delivery timeout and trap Stripe in a retry storm against the
  // already-failing linkgrep API.
  //
  // File-truth structural check (the actual end-to-end timing path
  // requires STRIPE_WEBHOOK_SECRET + a forged signature + a slow MSW
  // fixture; not available in the public OSS example). If the example
  // ever regresses to `await ...track.sale.safe`, this assertion fires.
  test("stripe-webhook handler dispatches track.sale WITHOUT awaiting it (#issue-1)", async () => {
    const fs = await import("node:fs/promises");
    const url = await import("node:url");
    const { fileURLToPath } = url;
    const here = fileURLToPath(new URL(".", import.meta.url));
    const filePath = `${here}../src/routes/api/stripe-webhook/+server.ts`;
    const src = await fs.readFile(filePath, "utf8");
    // The await pattern under test:
    //   const r = await getLinkgrep().track.sale.safe({ ... });
    // Pattern-matches any of `await getLinkgrep().track.sale` or
    // `await ...track.sale.safe` in the handler body — robust against
    // formatting (line breaks, intermediate vars).
    const offendingPattern = /\bawait\s+[^;]*track\.sale\.safe\s*\(/;
    expect(
      offendingPattern.test(src),
      "stripe-webhook handler must not await track.sale.safe — dispatch must be fire-and-forget so the 200 ack stays inside Stripe's delivery window. See https://docs.stripe.com/webhooks.",
    ).toBe(false);
    // Belt-and-braces: confirm the fire-and-forget shape IS present.
    expect(src, "the handler must invoke track.sale.safe via the void/.then dispatch pattern").toMatch(/\bvoid\s+getLinkgrep\(\)/);
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
