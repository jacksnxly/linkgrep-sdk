import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw-server.js";
import { Linkgrep } from "../linkgrep.js";
import { LinkgrepNetworkError } from "../http/errors.js";

const BASE = "https://api.example.test";

// Regression for keryx P4: HttpClient.post must reject responses whose
// declared content-length exceeds DEFAULT_MAX_RESPONSE_BYTES (1 MiB) before
// res.json() materializes the payload into heap. Applied to both success
// (.ok) and error (4xx/5xx) paths so a misbehaving or hostile origin cannot
// force the SDK consumer's process to allocate megabytes of JSON.
describe("HttpClient — response-size guard (P4)", () => {
  it("rejects success response when Content-Length exceeds 1 MiB cap", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        // Tell the client the body is 2 MiB; we don't actually send 2 MiB
        // because the SDK should reject BEFORE calling .json().
        new HttpResponse(JSON.stringify({ customerId: "c_1" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024),
          },
        }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    let thrown: unknown;
    try {
      await linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "u1" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LinkgrepNetworkError);
    expect((thrown as LinkgrepNetworkError).kind).toBe("network");
    expect((thrown as LinkgrepNetworkError).message).toMatch(/response too large/i);
  });

  it("rejects error response when Content-Length exceeds 1 MiB cap", async () => {
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        new HttpResponse(JSON.stringify({ error: { code: "internal_error", message: "boom" } }), {
          status: 500,
          headers: {
            "content-type": "application/json",
            "content-length": String(2 * 1024 * 1024),
          },
        }),
      ),
    );

    const linkgrep = new Linkgrep({
      token: "k",
      baseUrl: BASE,
      // Disable retry to keep the test fast; 500 would otherwise retry.
      retry: { maxAttempts: 1 },
    });
    let thrown: unknown;
    try {
      await linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "u1" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LinkgrepNetworkError);
    expect((thrown as LinkgrepNetworkError).kind).toBe("network");
  });

  it("accepts responses without Content-Length (chunked transfer) — guard is permissive on missing header", async () => {
    // Many origins omit Content-Length on chunked transfer. The guard only
    // fires on a DECLARED oversize; missing headers are passed through.
    server.use(
      http.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json({ customerId: "c_ok" }, { status: 200 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "u1" });
    if ("duplicate" in result) throw new Error("expected non-duplicate result");
    expect(result.customerId).toBe("c_ok");
  });
});
