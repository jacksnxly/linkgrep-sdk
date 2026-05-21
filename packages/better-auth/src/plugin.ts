import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import type { Linkgrep } from "linkgrep";

export interface LinkgrepAnalyticsOptions {
  client: Linkgrep;
  cookieName?: string;
  eventName?: string;
  paths?: string[];
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
  opts: LinkgrepAnalyticsOptions,
): BetterAuthPlugin {
  const cookieName = opts.cookieName ?? "lgr_id";
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
            ctx.context.runInBackground(
              opts.client.track.lead({
                clickId: clickId ?? undefined,
                eventName,
                customerExternalId: newUser.id,
                customerEmail: newUser.email ?? undefined,
                customerName: newUser.name ?? undefined,
                mode: clickId ? "fire-and-forget" : "deferred",
              }),
            );
          }),
        },
      ],
    },
  };
}
