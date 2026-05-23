import { env } from "$env/dynamic/private";
import { DEFAULT_CLICK_ID_COOKIE } from "linkgrep/protocol";

// Single source of truth for the linkgrep click-ID cookie name.
//
// Both the `/lgr` proxy filter (hooks.server.ts) and the better-auth
// plugin config (auth.ts) MUST consume from here — without this,
// changing `cookieName` on the plugin would silently desync from the
// proxy, which would then strip the renamed cookie before forwarding
// upstream and break attribution with no diagnostic.
//
// Override at runtime via `LINKGREP_CLICK_COOKIE=lg_custom`. Defaults
// to the SDK's `DEFAULT_CLICK_ID_COOKIE` ("lgr_id") imported via the
// `linkgrep/protocol` subpath (Node.js exports encapsulation —
// https://nodejs.org/api/packages.html — keeps the SDK barrel side
// effects out of any client bundle that might transitively reach this
// file).
//
// Keryx 2026-05-23 review, finding #2.
export const CLICK_COOKIE_NAME = env.LINKGREP_CLICK_COOKIE ?? DEFAULT_CLICK_ID_COOKIE;
