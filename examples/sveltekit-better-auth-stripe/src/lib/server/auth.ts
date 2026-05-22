import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Linkgrep } from "linkgrep";
import { linkgrepAnalytics } from "@linkgrep/better-auth";
import { env } from "$env/dynamic/private";

// $env/dynamic/private reads at runtime, so a missing var doesn't fail the
// build — necessary for CI runs that build the demo without secrets.
const linkgrep = new Linkgrep({ token: env.LINKGREP_API_KEY ?? "demo-key" });

// Demo uses memoryAdapter so the example is self-contained — no DB file,
// no migrations. State is lost on restart. Replace with a real adapter
// (Drizzle / Kysely / Prisma) for production. See:
// https://www.better-auth.com/docs/adapters/community-adapters
export const auth = betterAuth({
  baseURL: "http://localhost:5173",
  secret: process.env.AUTH_SECRET ?? "demo-secret-replace-in-production-min-32",
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
