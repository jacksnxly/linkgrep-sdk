import { Linkgrep, LinkgrepError, LinkgrepNetworkError, formatTrackError } from "linkgrep";
import { env } from "$env/dynamic/private";

// Single composition root for the linkgrep SDK in this example app.
// Both auth.ts (lead-tracking via the better-auth plugin) and the
// stripe-webhook route (sale-tracking) consume this — not their own
// independent constructors — so config drift between them is impossible
// by construction. Pattern: Seemann, "Dependency Injection in .NET" 2e,
// §4.2 "Composition Root".
//
// Twelve-Factor "Config" — refuse to boot in production without a real
// API key, allow demo builds to ship without secrets. The gate fires
// lazily on first call so SvelteKit's prerender step (which imports
// modules under NODE_ENV=production without env secrets) doesn't fail.
const IS_PROD = process.env.NODE_ENV === "production";

let _client: Linkgrep | undefined;

export function getLinkgrep(): Linkgrep {
  if (_client) return _client;
  const token = env.LINKGREP_API_KEY;
  if (IS_PROD && !token) {
    throw new Error("LINKGREP_API_KEY is required in production");
  }
  _client = new Linkgrep({ token: token ?? "demo-key" });
  return _client;
}

// Shared structured-log shape for failed track.lead / track.sale calls.
// Delegates the LinkgrepError / LinkgrepNetworkError formatting to the
// SDK's canonical `formatTrackError` helper so the plugin's onError
// fallback (packages/better-auth/src/plugin.ts) and every example /
// host integration emit the exact same key=value shape — no per-app
// field drift. (Keryx 2026-05-23, finding #7: the previous inline
// formatter here had silently dropped `docUrl`.)
//
// The `unknown` fallback below handles the rare case where the .safe()
// contract is violated by a programming bug in mapConflict / future
// code paths — the SDK's catch block in errors.ts:toResult already
// .from()-wraps unknown rejections, so this branch is defensive
// rather than expected.
export function logTrackError(prefix: string, error: unknown): void {
  if (error instanceof LinkgrepError || error instanceof LinkgrepNetworkError) {
    console.warn(formatTrackError(prefix, error));
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[linkgrep] ${prefix} unexpected error: ${message}`);
}
