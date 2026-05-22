// Regression tests for keryx batch validation 2026-05-22T1455Z:
//   - I-12: parse-seam runtime guard rejects non-object response bodies
//           (array, primitive) instead of casting to T blindly.
//   - I-14: default `mode` selection moved from the better-auth adapter
//           into the SDK — `mode` derives from `clickId` presence when
//           the caller omits it.
import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { Linkgrep, LinkgrepNetworkError } from "../index.js";
import { server } from "./msw-server.js";

const BASE = "https://api.linkgrep.test";

afterEach(() => {
  server.resetHandlers();
});

describe("I-12: parse-seam guard rejects non-object response bodies", () => {
  it("array response surfaces as LinkgrepNetworkError, not silent cast-to-T", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () => HttpResponse.json([1, 2, 3], { status: 200 })),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    let threw: unknown;
    try {
      await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      threw = e;
    }
    expect(threw, "array response must throw, not return [1,2,3] typed as TrackLeadResponse").toBeInstanceOf(LinkgrepNetworkError);
    expect((threw as Error).message).toMatch(/not a JSON object/i);
  });

  it("primitive response surfaces as LinkgrepNetworkError", async () => {
    server.use(
      http.post(`${BASE}/api/track/sale`, () => HttpResponse.json("just a string", { status: 200 })),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    let threw: unknown;
    try {
      await lg.track.sale({ amount: 100, clickId: "abc" });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(LinkgrepNetworkError);
    expect((threw as Error).message).toMatch(/not a JSON object/i);
  });
});

describe("I-14: SDK derives `mode` default from clickId presence", () => {
  it("with clickId → mode: 'fire-and-forget'", async () => {
    let receivedMode: string | undefined;
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        receivedMode = body.mode;
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    await lg.track.lead({
      eventName: "Sign Up",
      customerExternalId: "u",
      clickId: "click_abc",
      // no `mode` specified — SDK must derive
    });
    expect(receivedMode).toBe("fire-and-forget");
  });

  it("without clickId → mode: 'deferred'", async () => {
    let receivedMode: string | undefined;
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        receivedMode = body.mode;
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    await lg.track.lead({
      eventName: "Sign Up",
      customerExternalId: "u",
      // no clickId, no mode
    });
    expect(receivedMode).toBe("deferred");
  });

  it("explicit `mode` overrides the default", async () => {
    let receivedMode: string | undefined;
    server.use(
      http.post(`${BASE}/api/track/lead`, async ({ request }) => {
        const body = (await request.json()) as { mode?: string };
        receivedMode = body.mode;
        return HttpResponse.json({}, { status: 200 });
      }),
    );
    const lg = new Linkgrep({ token: "t", baseUrl: BASE, retry: { maxAttempts: 1 } });
    await lg.track.lead({
      eventName: "Sign Up",
      customerExternalId: "u",
      clickId: "click_abc",
      mode: "wait", // overrides the default-fire-and-forget for a clickId-bearing call
    });
    expect(receivedMode).toBe("wait");
  });
});
