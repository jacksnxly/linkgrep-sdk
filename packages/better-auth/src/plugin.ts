import type { BetterAuthPlugin } from "better-auth";
import {
  DEFAULT_CLICK_ID_COOKIE,
  formatTrackError,
  type Linkgrep,
  type LinkgrepError,
  type LinkgrepNetworkError,
} from "linkgrep";

export interface LinkgrepBetterAuthOptions {
  client: Linkgrep;
  cookieName?: string;
  eventName?: string;
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

/**
 * Attribution fires from `databaseHooks.user.create.after`, mirroring Dub's
 * official better-auth integration (github.com/dubinc/dub-better-auth,
 * src/index.ts — their 2025-05-05 redesign). better-auth merges a plugin's
 * `init().options.databaseHooks` as its own hook set alongside the host
 * app's hooks (better-auth/dist/context/helpers.mjs `runPluginInit`), so
 * both run.
 *
 * Why user-creation and not an endpoint matcher:
 *   - It is the only signal that fires exactly once per new user across
 *     EVERY signup surface — email/password, OAuth callbacks, magic link,
 *     web3 — with no per-provider path list to maintain.
 *   - It needs no session. Hosts with `requireEmailVerification: true`
 *     create the user session-less (`{ token: null }`); the previous
 *     `ctx.context.newSession` gate silently dropped every such signup.
 *   - Returning-user sign-in cannot fire it (no row is created), which
 *     removes the PII re-ship that endpoint matchers like `/callback/`
 *     suffered on every OAuth login.
 *
 * The click cookie is the referral signal: without it the hook returns
 * before any PII leaves the host. With it, the click necessarily happened
 * on the device performing the signup request, so the clickId is always
 * resolvable server-side ("fire-and-forget" mode).
 *
 * Deliberate deviation from dub-better-auth: the click cookie is NOT
 * cleared after the lead fires. Host checkout flows (e.g. Stripe metadata
 * enrichment) may still read it for sale-side attribution within the
 * cookie's natural lifetime, and the server dedupes leads on
 * (customerExternalId, eventName) — a 409 surfaces as `{duplicate: true}`,
 * not an error — so a lingering cookie cannot double-count.
 */
export function linkgrepAnalytics(opts: LinkgrepBetterAuthOptions): BetterAuthPlugin {
  const cookieName = opts.cookieName ?? DEFAULT_CLICK_ID_COOKIE;
  const eventName = opts.eventName ?? "Sign Up";

  return {
    id: "linkgrep-analytics",
    init: () => ({
      options: {
        databaseHooks: {
          user: {
            create: {
              after: async (user, ctx) => {
                // `ctx` is the request-scoped AuthEndpointContext; it is
                // null/undefined when the row is created outside a request
                // (seed scripts, admin imports) — nothing to attribute.
                if (!ctx) return;
                const clickId = ctx.getCookie(cookieName);
                if (!clickId) return;

                // NOTE on runInBackground: better-auth@1.6.x implements this as
                //   (p) => { p.catch(() => {}); }
                // i.e. it expects a Promise (already invoked), NOT a thunk.
                //
                // We use `track.lead.safe(...)` (Result<T,E> variant) so
                // background failures are observable via onError /
                // console.warn instead of being silently swallowed by
                // better-auth's catch-all. The signup flow never blocks on —
                // and never breaks on — attribution.
                // `mode` is intentionally omitted — the SDK derives
                // `fire-and-forget` from the clickId's presence (keryx I-14).
                ctx.context.runInBackground(
                  opts.client.track.lead
                    .safe({
                      clickId,
                      eventName,
                      customerExternalId: user.id,
                      customerEmail: user.email ?? undefined,
                      customerName: user.name ?? undefined,
                    })
                    .then((result) => {
                      if (!result.ok) {
                        // Pre-fix (keryx I-10), only `error.message` survived
                        // the log line. The SDK invests in a rich error shape
                        // (`code`, `status`, `requestId`, `docUrl` for
                        // LinkgrepError; `kind` for LinkgrepNetworkError);
                        // this plugin either delegates the full event to a
                        // host `onError` callback or emits the SDK's
                        // canonical structured-log line via
                        // `formatTrackError` (keryx 2026-05-23, finding #7).
                        if (opts.onError) {
                          opts.onError(result.error);
                          return;
                        }
                        console.warn(formatTrackError("track.lead", result.error));
                      }
                    }),
                );
              },
            },
          },
        },
      },
    }),
  };
}
