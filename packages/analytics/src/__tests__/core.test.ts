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
    init();
    expect(getClickId()).toBe("testclick123");
  });

  it("does nothing when ?lg_id= is absent", () => {
    window.location.search = "";
    init();
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
      init({ cookieDomain: ".athenum.xyz" });
      expect(writes.some(w => w.includes("Domain=.athenum.xyz"))).toBe(true);
    } finally {
      Object.defineProperty(document, "cookie", original);
    }
  });

  it("getClickId returns undefined when no cookie set", () => {
    expect(getClickId()).toBeUndefined();
  });

  // Regression for keryx issue #4: cookie-attribute injection via ?lg_id=
  // Attacker-controlled URL `?lg_id=foo;Max-Age=1` should NOT set the cookie at
  // all (input is not a valid click ID). Pre-fix, the SDK would still write the
  // cookie with a truncated value, masking malicious traffic as legitimate.
  it("ignores ?lg_id= values containing characters outside the click-ID alphabet", () => {
    window.location.search = "?lg_id=foo;Max-Age=1";
    init();
    expect(getClickId()).toBeUndefined();
  });

  it("ignores ?lg_id= values with whitespace, =, or other illegal cookie-octets", () => {
    for (const bad of ["foo bar", "foo=bar", "foo,bar", "foo\"bar", "foo\\bar"]) {
      window.location.search = `?lg_id=${encodeURIComponent(bad)}`;
      init();
      expect(getClickId(), `payload: ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("ignores ?lg_id= values longer than 200 characters", () => {
    const bigId = "a".repeat(201);
    window.location.search = `?lg_id=${bigId}`;
    init();
    expect(getClickId()).toBeUndefined();
  });

  // Regression for keryx issue #5: cookie write-amplification.
  // init() runs on every page load; without a read-first guard, every
  // navigation with a sticky `?lg_id=` URL re-issues an identical
  // Set-Cookie even when the cookie already holds the same value.
  it("writes the cookie exactly once across repeated init() calls with the same lg_id", () => {
    let proto: object | null = Object.getPrototypeOf(document);
    let original: PropertyDescriptor | undefined;
    while (proto) {
      original = Object.getOwnPropertyDescriptor(proto, "cookie");
      if (original) break;
      proto = Object.getPrototypeOf(proto);
    }
    if (!original) throw new Error("cookie descriptor not found");

    let writeCount = 0;
    Object.defineProperty(document, "cookie", {
      set(v: string) { writeCount++; original!.set?.call(this, v); },
      get() { return original!.get?.call(this) ?? ""; },
      configurable: true,
    });

    try {
      window.location.search = "?lg_id=testclick123";
      init();
      init();
      init();
      expect(writeCount, "init() should not re-write an unchanged cookie value").toBe(1);
    } finally {
      Object.defineProperty(document, "cookie", original);
    }
  });
});

// Asymmetric-trust regression (keryx 2026-05-23 review, finding #3).
// `init()` validates ?lg_id= against CLICK_ID_PATTERN before writing the
// cookie, but pre-fix `getClickId()` returned whatever was in
// `document.cookie` without revalidating. document.cookie is a shared
// writable surface (XSS payload, browser extension, DevTools, third-party
// script can all write it) — the SDK must treat it as untrusted input on
// read, matching how it treats ?lg_id= on write.
//
// OWASP Session Management Cheat Sheet: "Manage Session ID as Any Other
// User Input" — session/attribution identifiers are validated and verified.
describe("getClickId() defense-in-depth validation", () => {
  beforeEach(() => {
    document.cookie.split(";").forEach(c => {
      document.cookie = c.trim().split("=")[0] + "=;Max-Age=0;Path=/";
    });
  });

  it("rejects a cookie value with characters outside CLICK_ID_PATTERN", () => {
    // Simulate an XSS / extension / DevTools write that bypassed init().
    document.cookie = "lgr_id=foo;Path=/";
    // Manually inject a value containing `;` via the cookie getter override
    // (browsers normalize on write, so we override the getter).
    let proto: object | null = Object.getPrototypeOf(document);
    let original: PropertyDescriptor | undefined;
    while (proto && !original) {
      original = Object.getOwnPropertyDescriptor(proto, "cookie");
      if (!original) proto = Object.getPrototypeOf(proto);
    }
    if (!original) throw new Error("cookie descriptor not found");
    Object.defineProperty(document, "cookie", {
      get() { return "lgr_id=foo bar"; }, // space is illegal per CLICK_ID_PATTERN
      set() {},
      configurable: true,
    });
    try {
      expect(getClickId()).toBeUndefined();
    } finally {
      Object.defineProperty(document, "cookie", original);
    }
  });

  it("rejects a cookie value that exceeds the 200-char length cap", () => {
    const tooLong = "a".repeat(300);
    document.cookie = `lgr_id=${tooLong};Path=/`;
    expect(getClickId()).toBeUndefined();
  });

  it("rejects a cookie value containing control bytes", () => {
    let proto: object | null = Object.getPrototypeOf(document);
    let original: PropertyDescriptor | undefined;
    while (proto && !original) {
      original = Object.getOwnPropertyDescriptor(proto, "cookie");
      if (!original) proto = Object.getPrototypeOf(proto);
    }
    if (!original) throw new Error("cookie descriptor not found");
    Object.defineProperty(document, "cookie", {
      get() { return "lgr_id=foo\x01bar"; },
      set() {},
      configurable: true,
    });
    try {
      expect(getClickId()).toBeUndefined();
    } finally {
      Object.defineProperty(document, "cookie", original);
    }
  });

  it("returns a value that passes CLICK_ID_PATTERN unchanged", () => {
    document.cookie = "lgr_id=valid_click-ID_123;Path=/";
    expect(getClickId()).toBe("valid_click-ID_123");
  });
});
