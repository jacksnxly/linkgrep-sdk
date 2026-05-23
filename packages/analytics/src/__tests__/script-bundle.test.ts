import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Bundle-size + symbol-blocklist guard for the CDN-served IIFE.
//
// The IIFE is the most cost-sensitive bundle in the repo (loaded by every
// browser pageview from cdn.linkgrep.xyz). A regression that drags symbols
// from the SDK barrel — e.g. `new TextDecoder()` from `http/client.ts:52` —
// inflates cold-load cost without runtime value.
//
// Pre-fix (keryx 2026-05-23, finding #1), `packages/analytics/src/core.ts`
// imported `DEFAULT_CLICK_ID_COOKIE` + `CLICK_ID_PATTERN` from the SDK
// barrel `"linkgrep"`. The barrel transitively touches
// `packages/sdk/src/http/client.ts`, whose top-level
// `const RESPONSE_DECODER = new TextDecoder();` is a side-effecting
// allocation tsup cannot prove pure — so it survives tree-shaking into
// `dist/script.js` as `var k=new TextDecoder;`.
//
// Fix: deep subpath import `linkgrep/protocol` (Node.js exports-field
// encapsulation per https://nodejs.org/api/packages.html — "only the
// defined subpath in 'exports' can be imported by a consumer").
const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(here, "../../dist/script.js");
const INDEX_ESM_PATH = resolve(here, "../../dist/index.js");

describe("CDN IIFE bundle guard", () => {
  it("does not drag TextDecoder from the SDK http/client.ts side-effect", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    expect(content).not.toMatch(/TextDecoder/);
  });

  it("does not pull in fetch/JSON.parse/RESPONSE_DECODER from the SDK barrel", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    expect(content, "fetch is server-side; the IIFE has no business calling it").not.toMatch(
      /\bfetch\s*\(/,
    );
    expect(
      content,
      "JSON.parse on the browser path is a smell — analytics writes cookies only",
    ).not.toMatch(/JSON\.parse/);
  });

  it("stays under 1500 bytes (current baseline ~1153 bytes)", () => {
    const content = readFileSync(SCRIPT_PATH, "utf8");
    expect(content.length).toBeLessThan(1500);
  });
});

// dist/index.js is the ESM consumer surface — every React/Vite/Next/webpack
// consumer of `@linkgrep/analytics` resolves through it. The barrel must
// re-export protocol constants from `linkgrep/protocol`, NOT the full SDK
// barrel `linkgrep`, or the consumer's bundler will re-drag
// `packages/sdk/src/http/client.ts` (and its module-level `new TextDecoder()`)
// into their bundle. Empirically verified (keryx 2026-05-23, validation
// artifact bundle.js): `import { DEFAULT_CLICK_ID_COOKIE } from "@linkgrep/
// analytics"` produced a 96-byte esbuild bundle containing
// `var s=new TextDecoder` despite `sideEffects: false` on the SDK package
// AND `--tree-shaking=true` on esbuild. Control bundle via `linkgrep/
// protocol` direct: 57 bytes, 0 TextDecoder hits.
describe("ESM consumer-surface bundle guard", () => {
  it("does not import from the full `linkgrep` SDK barrel (must use `linkgrep/protocol` subpath)", () => {
    const content = readFileSync(INDEX_ESM_PATH, "utf8");
    expect(
      content,
      `dist/index.js must not retain a barrel import of "linkgrep" — that ` +
        `path re-drags http/client.ts's module-level TextDecoder into every ` +
        `downstream consumer bundle even with tree-shaking enabled.`,
    ).not.toMatch(/from\s*["']linkgrep["']/);
  });
});
