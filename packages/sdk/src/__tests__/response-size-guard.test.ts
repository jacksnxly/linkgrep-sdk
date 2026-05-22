import { describe, expect, it } from "vitest";
import http from "node:http";
import { http as mswHttp, HttpResponse, passthrough } from "msw";
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
      mswHttp.post(`${BASE}/api/track/lead`, () =>
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
      mswHttp.post(`${BASE}/api/track/lead`, () =>
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

  it("accepts responses under cap when Content-Length is missing (chunked, small body)", async () => {
    // Sanity check: a real upstream that streams a small JSON body via chunked
    // transfer-encoding (no Content-Length) must still succeed end-to-end.
    // Uses a real Node http server so transfer-encoding semantics are honest;
    // MSW cannot reproduce true chunked transfer.
    const srv = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.write("{\"customer");   // multiple writes => Node uses chunked, no CL
      res.write("Id\":\"c_ok\"}");
      res.end();
    });
    await new Promise<void>(r => srv.listen(0, r));
    try {
      const port = (srv.address() as { port: number }).port;
      server.use(mswHttp.all(`http://127.0.0.1:${port}/*`, () => passthrough()));
      const linkgrep = new Linkgrep({ token: "k", baseUrl: `http://127.0.0.1:${port}`, retry: { maxAttempts: 1 } });
      const result = await linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "u1" });
      if ("duplicate" in result) throw new Error("expected non-duplicate result");
      expect(result.customerId).toBe("c_ok");
    } finally { srv.close(); }
  });

  // Regression for keryx P4b (validated 2026-05-22): the size cap MUST hold
  // even when the upstream omits Content-Length and uses chunked transfer.
  // Pre-fix, this test passed (the SDK silently buffered megabytes); the
  // fix streams the body with a byte counter and rejects once the running
  // total crosses the cap.
  it("rejects chunked oversize response when Content-Length is missing", async () => {
    const PAYLOAD = 2 * 1024 * 1024;
    const padding = "x".repeat(PAYLOAD - 64);
    const body = JSON.stringify({ customerId: "c_oversize", _padding: padding });

    const srv = http.createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      // Multiple writes force Node to use Transfer-Encoding: chunked and
      // NOT auto-add Content-Length (a single res.end(body) would).
      const CHUNK = 64 * 1024;
      let i = 0;
      function next() {
        if (i >= body.length) { res.end(); return; }
        res.write(body.slice(i, i + CHUNK));
        i += CHUNK;
        setImmediate(next);
      }
      next();
    });
    await new Promise<void>(r => srv.listen(0, r));
    try {
      const port = (srv.address() as { port: number }).port;
      server.use(mswHttp.all(`http://127.0.0.1:${port}/*`, () => passthrough()));
      const linkgrep = new Linkgrep({ token: "k", baseUrl: `http://127.0.0.1:${port}`, retry: { maxAttempts: 1 } });
      let thrown: unknown;
      try {
        await linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "u1" });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LinkgrepNetworkError);
      expect((thrown as LinkgrepNetworkError).kind).toBe("network");
      expect((thrown as LinkgrepNetworkError).message).toMatch(/response too large/i);
    } finally { srv.close(); }
  });
});
