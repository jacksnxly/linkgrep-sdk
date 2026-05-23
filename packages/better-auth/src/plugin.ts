import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import {
  type Linkgrep,
  type LinkgrepError,
  type LinkgrepNetworkError,
  DEFAULT_CLICK_ID_COOKIE,
  formatTrackError,
} from "linkgrep";

export interface LinkgrepBetterAuthOptions {
  client: Linkgrep;
  cookieName?: string;
  eventName?: string;
  paths?: string[];
  /**
   * Optional structured-error hook fired when a background `track.lead` call
   * fails. The full `LinkgrepError` (with `.code`, `.status`, `.requestId`,
   * `.docUrl`) or `LinkgrepNetworkError` (with `.kind`) is passed through so
   * the host application's observability layer (Sentry, Datadog, Honeycomb)
   * can record the full diagnostic. When omitted, the plugin falls back to a
   * structured `console.warn` line that still preserves code / status /
   * requestId / docUrl / kind (keryx I-10).
   */
  onError?: (error: LinkgrepError | LinkgrepNetworkError) => void;
}

// Each entry is either an exact path or a path PREFIX ending with "/".
// Prefix entries match parameterized routes like /callback/google.
//
// Verified against better-auth@1.6.11:
//   - Email sign-up:   createAuthEndpoint("/sign-up/email", ...) (exact)
//   - OAuth callback:  createAuthEndpoint("/callback/:id", ...)   (prefix /callback/)
//   - Magic-link:      createAuthEndpoint("/sign-in/magic-link", ...) (exact)
//     (see node_modules/better-auth/dist/api/routes/callback.mjs and
//      node_modules/better-auth/dist/plugins/magic-link/index.mjs)
const DEFAULT_PATHS: readonly string[] = [
  "/sign-up/email",
  "/callback/", // OAuth callback for all providers (e.g. /callback/google)
  "/sign-in/magic-link",
];

export function matchesPath(
  path: string,
  patterns: readonly string[],
): boolean {
  for (const p of patterns) {
    if (p.endsWith("/")) {
      if (path.startsWith(p)) return true;
    } else if (path === p) {
      return true;
    }
  }
  return false;
}

export function linkgrepAnalytics(
  opts: LinkgrepBetterAuthOptions,
): BetterAuthPlugin {
  const cookieName = opts.cookieName ?? DEFAULT_CLICK_ID_COOKIE;
  const eventName = opts.eventName ?? "Sign Up";
  const paths = opts.paths ?? DEFAULT_PATHS;

  return {
    id: "linkgrep-analytics",
    hooks: {
      after: [
        {
          matcher: (ctx) =>
            typeof ctx.path === "string" && matchesPath(ctx.path, paths),
          handler: createAuthMiddleware(async (ctx) => {
            const newUser = ctx.context.newSession?.user;
            // Only fire on endpoints that produced a new session (sign-up,
            // social-callback, magic-link). Returning-user sign-in does not
            // populate newSession.
            if (!newUser) return;

            const clickId = ctx.getCookie(cookieName);

            // NOTE on runInBackground: better-auth@1.6.x implements this as
            //   (p) => { p.catch(() => {}); }
            // i.e. it expects a Promise (already invoked), NOT a thunk. Passing
            // a thunk would throw a TypeError because `p.catch` is undefined on
            // a function. Server accepts mode "wait" | "fire-and-forget" |
            // "deferred" — NEVER "async".
            //
            // We use `track.lead.safe(...)` (Result<T,E> variant) so background
            // failures are observable via console.warn instead of being
            // silently swallowed by better-auth's catch-all. The auth flow
            // never breaks on attribution failure.
            // `mode` is intentionally omitted — the SDK derives it from
            // `clickId` presence (`fire-and-forget` when present, `deferred`
            // when not). Pre-fix (keryx I-14), this adapter encoded the rule
            // itself; the move into createLeadTracker means every other
            // adapter (NextAuth, Lucia, Hono, …) inherits the same semantics.
            ctx.context.runInBackground(
              opts.client.track.lead
                .safe({
                  clickId: clickId ?? undefined,
                  eventName,
                  customerExternalId: newUser.id,
                  customerEmail: newUser.email ?? undefined,
                  customerName: newUser.name ?? undefined,
                })
                .then((result) => {
                  if (!result.ok) {
                    // Pre-fix (keryx I-10), only `error.message` survived the
                    // log line. The SDK invests in a rich error shape
                    // (`code`, `status`, `requestId`, `docUrl` for
                    // LinkgrepError; `kind` for LinkgrepNetworkError); this
                    // plugin either delegates the full event to a host
                    // `onError` callback (Sentry / Datadog / Honeycomb) or
                    // emits the SDK's canonical structured-log line via
                    // `formatTrackError` (single source of truth across
                    // plugin + example apps — keryx 2026-05-23, finding #7).
                    if (opts.onError) {
                      opts.onError(result.error);
                      return;
                    }
                    console.warn(formatTrackError("track.lead", result.error));
                  }
                }),
            );
          }),
        },
      ],
    },
  };
}
