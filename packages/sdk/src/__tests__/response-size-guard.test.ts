import { HttpResponse, http as mswHttp } from "msw";
import { describe, expect, it } from "vitest";
import { readJsonWithByteCap } from "../http/client.js";
import { LinkgrepNetworkError } from "../http/errors.js";
import { Linkgrep } from "../linkgrep.js";
import { server } from "./msw-server.js";

const BASE = "https://api.example.test";

// Regression for keryx P4: HttpClient.post must reject responses whose
// declared content-length exceeds DEFAULT_MAX_RESPONSE_BYTES (1 MiB) before
// res.json() materializes the payload into heap. Applied to both success
// (.ok) and error (4xx/5xx) paths so a misbehaving or hostile origin cannot
// force the SDK consumer's process to allocate megabytes of JSON.
describe("HttpClient — response-size guard (P4)", () => {
  it("rejects success response when Content-Length exceeds 1 MiB cap", async () => {
    server.use(
      mswHttp.post(
        `${BASE}/api/track/lead`,
        () =>
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
    expect((thrown as LinkgrepNetworkError).kind).toBe("oversize");
    expect((thrown as LinkgrepNetworkError).message).toMatch(/response too large/i);
  });

  it("rejects error response when Content-Length exceeds 1 MiB cap", async () => {
    server.use(
      mswHttp.post(
        `${BASE}/api/track/lead`,
        () =>
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
    expect((thrown as LinkgrepNetworkError).kind).toBe("oversize");
  });

  it("accepts responses without Content-Length (small body, no cap risk)", async () => {
    // MSW path: ensures the SDK's end-to-end .post() still works when the
    // upstream returns a normal small JSON body without Content-Length.
    // (Streaming semantics for chunked oversize are covered by the helper
    // tests below since MSW eagerly drains ReadableStream bodies.)
    server.use(
      mswHttp.post(`${BASE}/api/track/lead`, () =>
        HttpResponse.json({ customerId: "c_ok" }, { status: 200 }),
      ),
    );

    const linkgrep = new Linkgrep({ token: "k", baseUrl: BASE });
    const result = await linkgrep.track.lead({ eventName: "Sign Up", customerExternalId: "u1" });
    if ("duplicate" in result) throw new Error("expected non-duplicate result");
    expect(result.customerId).toBe("c_ok");
  });
});

// Regression for keryx P4b (validated 2026-05-22): the size cap MUST hold
// even when the upstream omits Content-Length and uses chunked transfer.
// Pre-fix, the SDK silently buffered megabytes; the fix streams the body
// with a byte counter and rejects once the running total crosses the cap.
//
// Tested at the helper level rather than through the SDK + MSW because
// MSW v2's response wrapper eagerly drains ReadableStream bodies before
// returning, which masks the streaming semantics under test. The helper
// IS what runs in production; the SDK-level call site just hands a real
// `Response` (from `fetch`) to it. End-to-end behavior is proven by the
// keryx validation probe at
// .keryx/validations/artifacts-2026-05-22T1253Z/issue-1-probe-true-chunked.mjs
// against a real Node http.createServer.
describe("readJsonWithByteCap — streaming guard (keryx P4b)", () => {
  function chunkedResponseStream(payload: string, opts: { contentLength?: number } = {}): Response {
    const enc = new TextEncoder();
    const CHUNK = 64 * 1024;
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= payload.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(payload.slice(offset, offset + CHUNK)));
        offset += CHUNK;
      },
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.contentLength !== undefined) headers["content-length"] = String(opts.contentLength);
    return new Response(stream, { status: 200, headers });
  }

  it("rejects when streamed body exceeds cap (no Content-Length declared)", async () => {
    const PAYLOAD = 2 * 1024 * 1024;
    const padding = "x".repeat(PAYLOAD - 64);
    const body = JSON.stringify({ customerId: "c_oversize", _padding: padding });
    const res = chunkedResponseStream(body);

    let thrown: unknown;
    try {
      await readJsonWithByteCap(res, 1024 * 1024);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LinkgrepNetworkError);
    expect((thrown as LinkgrepNetworkError).kind).toBe("oversize");
    expect((thrown as LinkgrepNetworkError).message).toMatch(/response too large/i);
  });

  it("accepts a streamed body under the cap (no Content-Length declared)", async () => {
    const body = JSON.stringify({ customerId: "c_ok", note: "small" });
    const res = chunkedResponseStream(body);
    const parsed = await readJsonWithByteCap(res, 1024 * 1024);
    expect(parsed).toEqual({ customerId: "c_ok", note: "small" });
  });

  it("returns null for empty body", async () => {
    const stream = new ReadableStream({
      start(c) {
        c.close();
      },
    });
    const res = new Response(stream, { status: 200 });
    const parsed = await readJsonWithByteCap(res, 1024 * 1024);
    expect(parsed).toBeNull();
  });

  it("propagates AbortError thrown by reader.read()", async () => {
    const stream = new ReadableStream({
      pull() {
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e;
      },
    });
    const res = new Response(stream, { status: 200 });
    let thrown: unknown;
    try {
      await readJsonWithByteCap(res, 1024 * 1024);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe("AbortError");
  });
});
