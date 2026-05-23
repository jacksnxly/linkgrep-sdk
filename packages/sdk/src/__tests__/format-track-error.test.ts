// Regression for keryx 2026-05-23 review, finding #7: structured-log
// drift between the @linkgrep/better-auth plugin's onError fallback and
// the example app's logTrackError helper. Pre-fix the example dropped
// `docUrl` while claiming to mirror the plugin's shape. Both call sites
// now route through the SDK's canonical `formatTrackError` helper, so
// this test pins the shape — adding / renaming / dropping a field here
// is the explicit decision-point for both consumers simultaneously.
import { describe, expect, it } from "vitest";
import {
  formatTrackError,
  LinkgrepError,
  LinkgrepNetworkError,
} from "../index.js";

describe("formatTrackError — single-source structured-log shape", () => {
  it("LinkgrepError emits code / status / requestId / docUrl / message", () => {
    const err = new LinkgrepError({
      status: 422,
      code: "unprocessable",
      message: "amount must be > 0",
      docUrl: "https://docs.linkgrep.xyz/errors/unprocessable",
      requestId: "req_abc123",
      raw: null,
      headers: new Headers(),
    });
    expect(formatTrackError("track.sale", err)).toBe(
      "[linkgrep] track.sale failed: code=unprocessable status=422 requestId=req_abc123 docUrl=https://docs.linkgrep.xyz/errors/unprocessable message=amount must be > 0",
    );
  });

  it("LinkgrepError missing optional fields renders them as `-`", () => {
    const err = new LinkgrepError({
      status: 500,
      code: "internal_error",
      message: "boom",
      raw: null,
      headers: new Headers(),
    });
    expect(formatTrackError("track.lead", err)).toBe(
      "[linkgrep] track.lead failed: code=internal_error status=500 requestId=- docUrl=- message=boom",
    );
  });

  it("LinkgrepNetworkError emits kind / message", () => {
    const err = new LinkgrepNetworkError("timeout", "request budget exhausted");
    expect(formatTrackError("track.lead", err)).toBe(
      "[linkgrep] track.lead transport failure: kind=timeout message=request budget exhausted",
    );
  });
});
