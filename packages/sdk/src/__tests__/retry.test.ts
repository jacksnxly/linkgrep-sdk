import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../http/retry.js";
import { LinkgrepError } from "../http/errors.js";

describe("withRetry", () => {
  it("retries on 429 up to 3 times and succeeds on 3rd attempt", async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new LinkgrepError(429, "rate_limited", "Too many requests");
      return "ok";
    });

    const result = await withRetry(fn, 3);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry on 401", async () => {
    const fn = vi.fn(async () => {
      throw new LinkgrepError(401, "unauthorized", "Unauthorized");
    });

    await expect(withRetry(fn, 3)).rejects.toThrow(LinkgrepError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting retries", async () => {
    const fn = vi.fn(async () => {
      throw new LinkgrepError(500, "server_error", "Internal Server Error");
    });

    await expect(withRetry(fn, 3)).rejects.toThrow(LinkgrepError);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
