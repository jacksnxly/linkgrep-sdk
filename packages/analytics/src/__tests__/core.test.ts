import { describe, expect, it, beforeEach } from "vitest";
import { init, getClickId } from "../core.js";

describe("init()", () => {
  beforeEach(() => {
    // reset URL
    Object.defineProperty(window, "location", {
      value: { search: "", protocol: "https:" },
      writable: true,
    });
    // clear cookies
    document.cookie.split(";").forEach(c => {
      document.cookie = c.trim().split("=")[0] + "=;Max-Age=0;Path=/";
    });
  });

  it("writes lgr_id cookie when ?lg_id= is present in URL", () => {
    window.location.search = "?lg_id=testclick123";
    init({ publishableKey: "lg_pk_test" });
    expect(getClickId()).toBe("testclick123");
  });

  it("does nothing when ?lg_id= is absent", () => {
    window.location.search = "";
    init({ publishableKey: "lg_pk_test" });
    expect(getClickId()).toBeUndefined();
  });

  it("uses cookieDomain option when provided", () => {
    // Walk prototype chain to find the cookie descriptor (Task 6 pattern).
    let proto: object | null = Object.getPrototypeOf(document);
    let original: PropertyDescriptor | undefined;
    while (proto) {
      original = Object.getOwnPropertyDescriptor(proto, "cookie");
      if (original) break;
      proto = Object.getPrototypeOf(proto);
    }
    if (!original) throw new Error("cookie descriptor not found");

    const writes: string[] = [];
    Object.defineProperty(document, "cookie", {
      set(v: string) { writes.push(v); original!.set?.call(this, v); },
      get() { return original!.get?.call(this) ?? ""; },
      configurable: true,
    });

    try {
      window.location.search = "?lg_id=abc";
      init({ publishableKey: "lg_pk_test", cookieDomain: ".athenum.xyz" });
      expect(writes.some(w => w.includes("Domain=.athenum.xyz"))).toBe(true);
    } finally {
      Object.defineProperty(document, "cookie", original);
    }
  });

  it("getClickId returns undefined when no cookie set", () => {
    expect(getClickId()).toBeUndefined();
  });
});
