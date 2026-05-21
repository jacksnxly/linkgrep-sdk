import { betterAuth } from "better-auth";
import { Linkgrep } from "linkgrep";
import { linkgrepAnalytics } from "@linkgrep/better-auth";
import { LINKGREP_API_KEY } from "$env/static/private";

const linkgrep = new Linkgrep({ token: LINKGREP_API_KEY });

export const auth = betterAuth({
  database: { provider: "sqlite", url: "local.db" } as never,
  emailAndPassword: { enabled: true },
  plugins: [
    linkgrepAnalytics({
      client: linkgrep,
      cookieName: "lgr_id",
      eventName: "Sign Up",
    }),
  ],
});
