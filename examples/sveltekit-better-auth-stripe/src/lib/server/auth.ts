import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Linkgrep } from "linkgrep";
import { linkgrepAnalytics } from "@linkgrep/better-auth";
import { env } from "$env/dynamic/private";

// Twelve-Factor "Config" — store config in the environment, refuse to boot
// when production secrets are missing rather than degrading to a literal
// committed in source. https://12factor.net/config
//
// `$env/dynamic/private` reads at runtime, so a missing var doesn't fail the
// SvelteKit build — necessary for CI runs that build the demo without secrets.
// We only fall back to the demo literals when NODE_ENV !== "production".
const IS_PROD = process.env.NODE_ENV === "production";

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
export const auth = betterAuth({
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
      cookieName: "lgr_id",
      eventName: "Sign Up",
    }),
  ],
});
