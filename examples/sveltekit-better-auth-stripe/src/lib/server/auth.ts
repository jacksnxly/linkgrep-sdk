import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { linkgrepAnalytics } from "@linkgrep/better-auth";
import { env } from "$env/dynamic/private";
import { getLinkgrep } from "$lib/server/linkgrep";
import { CLICK_COOKIE_NAME } from "$lib/server/click-cookie";

// Twelve-Factor "Config" — secrets live in the environment, never in
// source. The linkgrep client is built once via the shared composition
// root in $lib/server/linkgrep so config (token, baseUrl, retry, fetch)
// never drifts between this module and the stripe-webhook route.
//
// Env access goes through `$env/dynamic/private` (SvelteKit's
// adapter-aware runtime API) rather than raw `process.env`. Per
// https://svelte.dev/docs/kit/$env-dynamic-private: "Dynamic environment
// variables are defined by the platform you're running on. For example
// if you're using adapter-node (or running vite preview), this is
// equivalent to process.env." On serverless adapters (adapter-cloudflare,
// adapter-vercel-edge) it is the only API that respects per-request
// platform env — `process.env` is silently empty there. Standardizing
// across this composition root removes a footgun for anyone porting the
// example to a non-Node host. Keryx 2026-05-23, finding #5.
//
// The AUTH_SECRET gate fires lazily on first request rather than at
// module-load time because SvelteKit's `vite build` runs the prerender
// `analyse` step under NODE_ENV=production, which imports this module.
// Throwing at import time would fail every CI build without secrets —
// the build artifact is fine, only the running server needs them.
const IS_PROD = env.NODE_ENV === "production";

let _instance: ReturnType<typeof betterAuth> | undefined;

function build(): ReturnType<typeof betterAuth> {
  const authSecret = env.AUTH_SECRET;
  if (IS_PROD && !authSecret) {
    throw new Error("AUTH_SECRET is required in production");
  }

  // Demo uses memoryAdapter so the example is self-contained — no DB file,
  // no migrations. State is lost on restart. Replace with a real adapter
  // (Drizzle / Kysely / Prisma) for production. See:
  // https://www.better-auth.com/docs/adapters/community-adapters
  return betterAuth({
    baseURL: env.AUTH_BASE_URL ?? "http://localhost:5173",
    secret: authSecret ?? "demo-secret-replace-in-production-min-32",
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [
      linkgrepAnalytics({
        client: getLinkgrep(),
        // Pass the cookie name explicitly from the shared composition
        // module so this plugin config and the /lgr proxy filter
        // (hooks.server.ts) stay in lockstep. Pre-fix (keryx 2026-05-23,
        // finding #2), the proxy was hardcoded to the SDK default while
        // this plugin accepted overrides — a `LINKGREP_CLICK_COOKIE`
        // override would silently desync them.
        cookieName: CLICK_COOKIE_NAME,
        eventName: "Sign Up",
      }),
    ],
  });
}

// Proxy lazily constructs the betterAuth instance on first property access.
// Build-time module evaluation never accesses a property, so the env-gate
// stays dormant until a real request arrives.
export const auth = new Proxy({} as ReturnType<typeof betterAuth>, {
  get(_target, prop) {
    if (!_instance) _instance = build();
    return Reflect.get(_instance, prop);
  },
});
