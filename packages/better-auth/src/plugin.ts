import { createAuthMiddleware } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import type { Linkgrep } from "linkgrep";

export interface LinkgrepAnalyticsOptions {
  client: Linkgrep;
  cookieName?: string;
  eventName?: string;
  paths?: string[];
}

const DEFAULT_PATHS = [
  "/sign-up/email",
  "/sign-in/social/callback",
  "/sign-in/magic-link",
];

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
            typeof ctx.path === "string" && paths.includes(ctx.path),
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
