import { defineConfig } from "tsup";
// Two entry points: the main barrel + a `protocol` subpath that holds the
// cross-package constants (DEFAULT_CLICK_ID_COOKIE, CLICK_ID_PATTERN).
// Browser consumers (@linkgrep/analytics) import from `linkgrep/protocol`
// so the IIFE bundler never crosses into http/client.ts's module-level
// `new TextDecoder()` side effect. Keryx 2026-05-23, finding #1.
//
// Per nodejs.org/api/packages.html "Subpath exports": only entries listed
// in the package.json `"exports"` map are reachable; deep paths return
// ERR_PACKAGE_PATH_NOT_EXPORTED. The subpath is the canonical mechanism
// for surfacing a stable internal module without re-exporting it through
// the barrel.
export default defineConfig({
  entry: ["src/index.ts", "src/protocol.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: true,
  treeshake: true,
  clean: true,
  target: "es2022",
});
