import { describe, expect, it, beforeEach } from "vitest";
import { getCookieValue, setCookie } from "../cookie.js";

describe("cookie utilities", () => {
  beforeEach(() => {
    // clear all cookies between tests
    document.cookie.split(";").forEach(c => {
      document.cookie = c.trim().split("=")[0] + "=;Max-Age=0;Path=/";
    });
  });

  it("setCookie writes a readable cookie", () => {
    setCookie("test_key", "test_value", { sameSite: "Lax" });
    expect(getCookieValue("test_key")).toBe("test_value");
  });

  it("getCookieValue returns undefined for missing cookie", () => {
    expect(getCookieValue("nonexistent")).toBeUndefined();
  });

  // Regression for keryx issue #3: split("=")[1] drops trailing `=` chars.
  // Base64 / base64url values commonly end in `=` padding; the SDK must
  // round-trip them losslessly.
  it("getCookieValue preserves trailing `=` padding (base64 values)", () => {
    setCookie("lgr_id", "YWJjZA==", { sameSite: "Lax" });
    expect(getCookieValue("lgr_id")).toBe("YWJjZA==");
  });

  it("getCookieValue preserves values containing `=` in the middle", () => {
    setCookie("lgr_id", "a=b=c", { sameSite: "Lax" });
    expect(getCookieValue("lgr_id")).toBe("a=b=c");
  });

  it("setCookie with domain attribute includes Domain in string", () => {
    // happy-dom ignores Domain but we can test the string building
    // by spying on document.cookie setter
    const writes: string[] = [];
    // happy-dom places the cookie descriptor on Document (not Document.prototype),
    // so walk the prototype chain to find it.
    let proto: object | null = Object.getPrototypeOf(document);
    let original: PropertyDescriptor | undefined;
    while (proto && !original) {
      original = Object.getOwnPropertyDescriptor(proto, "cookie");
      if (!original) proto = Object.getPrototypeOf(proto);
    }
    if (!original || !proto) throw new Error("cookie descriptor not found");
    Object.defineProperty(document, "cookie", {
      set(v: string) { writes.push(v); original!.set?.call(this, v); },
      get() { return original!.get?.call(this) ?? ""; },
      configurable: true,
    });

    setCookie("lg_click_id", "abc", { domain: ".athenum.xyz", sameSite: "Lax", secure: true });

    expect(writes.some(w => w.includes("Domain=.athenum.xyz"))).toBe(true);
    expect(writes.some(w => w.includes("SameSite=Lax"))).toBe(true);
    expect(writes.some(w => w.includes("Secure"))).toBe(true);

    Object.defineProperty(document, "cookie", original!);
  });
});
