import { Linkgrep, LinkgrepError } from "linkgrep";
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
// Mirrors the structured-error shape that @linkgrep/better-auth ships
// natively (packages/better-auth/src/plugin.ts:119-127). Both the
// webhook handler and any future track callers route through this so
// the demo demonstrates one consistent logging idiom.
export function logTrackError(prefix: string, error: unknown): void {
  if (error instanceof LinkgrepError) {
    console.warn(
      `[linkgrep] ${prefix} failed: code=${error.code} status=${error.status} requestId=${error.requestId ?? "-"} message=${error.message}`,
    );
    return;
  }
  if (error && typeof error === "object" && "kind" in error && "message" in error) {
    const e = error as { kind: string; message: string };
    console.warn(`[linkgrep] ${prefix} transport failure: kind=${e.kind} message=${e.message}`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[linkgrep] ${prefix} unexpected error: ${message}`);
}
