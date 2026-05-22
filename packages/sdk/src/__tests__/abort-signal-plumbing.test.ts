// Regression tests for keryx batch validation 2026-05-22T1455Z:
//   - C-2: totalBudgetMs must bound the IN-FLIGHT per-attempt request,
//          not just the sleep schedule between attempts. Pre-fix, a
//          hanging upstream blocked for the full `timeoutMs` regardless
//          of `totalBudgetMs`.
//   - I-3: HttpClientOptions must accept a caller-supplied AbortSignal so
//          consumers can cancel mid-retry / mid-sleep (browser tab close,
//          parent request abort).
//   - I-4: HttpClientOptions must accept an injectable `fetch` for
//          Cloudflare Workers / undici Agent / test-stub use cases.
import { afterEach, describe, expect, it } from "vitest";
import { http } from "msw";
import { Linkgrep, LinkgrepNetworkError } from "../index.js";
import { server } from "./msw-server.js";

const BASE = "https://api.linkgrep.test";

afterEach(() => {
  server.resetHandlers();
});

describe("C-2: totalBudgetMs bounds the in-flight per-attempt request", () => {
  it("times out within ~totalBudgetMs on a hanging upstream, not at timeoutMs", async () => {
    // MSW handler that never resolves — simulates an upstream that wrote
    // headers but hangs on the body. The pre-fix behavior blocked for
    // `timeoutMs` (2s here); the contract says ~totalBudgetMs (200ms).
    server.use(
      http.post(`${BASE}/api/track/lead`, () => new Promise(() => { /* never */ })),
    );
    const lg = new Linkgrep({
      token: "t",
      baseUrl: BASE,
      timeoutMs: 2000,
      retry: { totalBudgetMs: 200, maxAttempts: 3 },
    });
    const start = Date.now();
    let threw: unknown;
    try {
      await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - start;
    expect(threw).toBeInstanceOf(LinkgrepNetworkError);
    // Allow generous headroom — anything well under timeoutMs proves the
    // budget gate is closing the attempt, not the per-attempt timer.
    expect(elapsed, `must time out within ~totalBudgetMs (200ms), got ${elapsed}ms`).toBeLessThan(800);
  });
});

describe("I-3: caller-supplied AbortSignal cancels mid-retry", () => {
  it("aborting the caller signal during the backoff sleep rejects immediately", async () => {
    let hits = 0;
    server.use(
      http.post(`${BASE}/api/track/lead`, () => {
        hits++;
        return new Response(JSON.stringify({ error: { code: "internal_error" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    const ac = new AbortController();
    const lg = new Linkgrep({
      token: "t",
      baseUrl: BASE,
      // Long backoff so the abort lands while the loop is sleeping.
      retry: { maxAttempts: 3, baseDelayMs: 500, maxBackoffMs: 1000 },
      signal: ac.signal,
    });
    const start = Date.now();
    setTimeout(() => ac.abort(new Error("caller-cancelled")), 100);
    let threw: unknown;
    try {
      await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - start;
    expect(threw, "abort signal must surface a terminal transport error").toBeInstanceOf(LinkgrepNetworkError);
    expect((threw as LinkgrepNetworkError).kind).toBe("abort");
    expect(hits, "should have attempted at most once before abort fired").toBeLessThanOrEqual(1);
    expect(elapsed, `caller abort must short-circuit the backoff sleep (~100ms), got ${elapsed}ms`).toBeLessThan(400);
  });
});

describe("I-4: injectable fetch transport", () => {
  it("uses the user-supplied fetch function instead of globalThis.fetch", async () => {
    const calls: { input: string; init: RequestInit }[] = [];
    const customFetch: typeof fetch = async (input, init) => {
      calls.push({ input: String(input), init: init as RequestInit });
      return new Response(JSON.stringify({ customerId: "cus_injected" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const lg = new Linkgrep({
      token: "test-token",
      baseUrl: BASE,
      fetch: customFetch,
      retry: { maxAttempts: 1 },
    });
    const result = await lg.track.lead({ eventName: "x", customerExternalId: "u" });
    expect(calls.length, "custom fetch must be called instead of global").toBe(1);
    expect(calls[0]!.input).toBe(`${BASE}/api/track/lead`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect(result).toEqual({ customerId: "cus_injected" });
  });
});
