import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Linkgrep } from "linkgrep";
import { linkgrepAnalytics } from "@linkgrep/better-auth";
import { env } from "$env/dynamic/private";

// Twelve-Factor "Config" — store config in the environment, refuse to boot
// when production secrets are missing rather than degrading to a literal
// committed in source. https://12factor.net/config
//
// IMPORTANT: SvelteKit's `vite build` runs the prerender `analyse` step under
// NODE_ENV=production, which imports this module. If we threw at module
// import time, every CI build without secrets would fail (which is wrong —
// the build artifact is fine, only the running server needs the secrets).
// So the gate fires LAZILY on first request: build stays green, but the
// running server refuses to handle traffic without real secrets.
const IS_PROD = process.env.NODE_ENV === "production";

let _instance: ReturnType<typeof betterAuth> | undefined;

function build(): ReturnType<typeof betterAuth> {
  const linkgrepApiKey = env.LINKGREP_API_KEY;
  if (IS_PROD && !linkgrepApiKey) {
    throw new Error("LINKGREP_API_KEY is required in production");
  }
  const linkgrep = new Linkgrep({ token: linkgrepApiKey ?? "demo-key" });

  const authSecret = process.env.AUTH_SECRET;
  if (IS_PROD && !authSecret) {
    throw new Error("AUTH_SECRET is required in production");
  }

  // Demo uses memoryAdapter so the example is self-contained — no DB file,
  // no migrations. State is lost on restart. Replace with a real adapter
  // (Drizzle / Kysely / Prisma) for production. See:
  // https://www.better-auth.com/docs/adapters/community-adapters
  return betterAuth({
    baseURL: process.env.AUTH_BASE_URL ?? "http://localhost:5173",
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
        client: linkgrep,
        // `cookieName` intentionally omitted — the plugin defaults to
        // `DEFAULT_CLICK_ID_COOKIE` from the SDK's `protocol.ts`. Passing
        // it explicitly here would teach the unnecessary import and
        // override the canonical default if the SDK ever changes it.
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
