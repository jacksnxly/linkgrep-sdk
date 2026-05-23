import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { http, passthrough } from "msw";
import { beforeAll, describe, expect, it } from "vitest";
import { HttpClient } from "../http/client.js";
import { LinkgrepError, LinkgrepNetworkError } from "../http/errors.js";
import { server as mswServer } from "./msw-server.js";

// The shared MSW server intercepts every fetch (onUnhandledRequest: "error").
// This test hits a real localhost server, so register a passthrough for it.
beforeAll(() => {
  mswServer.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
});

// Regression for keryx #I1: `res.json().catch(() => null)` in HttpClient.post
// swallows TimeoutError thrown during the body stream of an error response.
// The swallowed TimeoutError gets reclassified as a retryable LinkgrepError,
// which retry.ts then retries — defeating the per-request `timeoutMs` contract.
//
// Subsequently hardened by keryx batch-3 (A1): the throwing path now wraps
// raw DOMException("TimeoutError"|"AbortError") and other transport failures
// into LinkgrepNetworkError so consumers writing `catch (e instanceof
// LinkgrepError)` see a consistent sealed union with `.safe()` callers.
describe("HttpClient — body-read TimeoutError propagation (#I1, A1)", () => {
  it("surfaces a body-read timeout as LinkgrepNetworkError(kind=timeout), not raw DOMException", async () => {
    let attempts = 0;
    const server: Server = createServer((_req, res) => {
      attempts++;
      // Send 500 status + headers, then never end the body. The client's
      // AbortSignal.timeout will fire while res.json() is still pending.
      res.writeHead(500, { "content-type": "application/json" });
      res.write('{"error":{"code":"slow_body"');
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    try {
      const client = new HttpClient({
        token: "test",
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 200,
      });

      const start = Date.now();
      let thrown: unknown;
      try {
        await client.post("/probe", {});
      } catch (err) {
        thrown = err;
      }
      const elapsed = Date.now() - start;

      // Correct behavior post-A1: exactly one attempt, thrown is LinkgrepNetworkError
      // with kind="timeout" (originating DOMException attached as `.cause`),
      // elapsed roughly == timeoutMs.
      // Bug behavior pre-A1: thrown was raw DOMException("TimeoutError"), bypassing
      // the documented LinkgrepError | LinkgrepNetworkError union.
      // Pre-#I1 bug: 3 attempts, elapsed ~= 3 * 1000ms (exp backoff), thrown == InternalServerError.
      expect(attempts).toBe(1);
      expect(thrown).toBeInstanceOf(LinkgrepNetworkError);
      expect((thrown as LinkgrepNetworkError).kind).toBe("timeout");
      expect(thrown).not.toBeInstanceOf(LinkgrepError);
      expect(((thrown as LinkgrepNetworkError).cause as Error | undefined)?.name).toBe(
        "TimeoutError",
      );
      expect(elapsed).toBeLessThan(1500);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 30_000);
});
