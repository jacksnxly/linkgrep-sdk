// Re-export the canonical cookie name from the SDK so consumers of
// @linkgrep/analytics don't need to also depend on `linkgrep` for it.
//
// Import via `linkgrep/protocol` (Node.js exports-field subpath — see
// https://nodejs.org/api/packages.html "only the defined subpath in
// 'exports' can be imported by a consumer") rather than the full barrel
// `linkgrep`. Going through the barrel transitively touches
// `packages/sdk/src/http/client.ts`, whose top-level
// `const RESPONSE_DECODER = new TextDecoder()` is a side-effecting
// allocation that survives tree-shaking into every downstream consumer
// bundle — even with `sideEffects: false` on the SDK package. Empirically
// measured at 96 bytes (with `TextDecoder` leak) vs 57 bytes (clean) for a
// minimal esbuild consumer. The IIFE path in `core.ts` already uses this
// subpath; `script-bundle.test.ts` guards both bundles against regression.
export { DEFAULT_CLICK_ID_COOKIE } from "linkgrep/protocol";
export type { LinkgrepBrowserAnalyticsOptions } from "./core.js";
export { getClickId, init } from "./core.js";
