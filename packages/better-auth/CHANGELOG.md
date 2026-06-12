# @linkgrep/better-auth

## 0.2.0

### Minor Changes

- fc34ac6: Rewrite lead attribution to fire from `databaseHooks.user.create.after`, aligned with Dub's official better-auth integration.

  **Breaking changes:**

  - The `paths` option is removed. Attribution no longer matches auth endpoints; it fires when a user row is created, for every signup surface (email/password, OAuth callbacks, magic link), and can never fire on returning-user sign-in.
  - Cookie-less signups no longer send a `deferred`-mode lead. The click cookie is the referral signal — without it, no request (and no PII) leaves the host app.
  - `better-auth` peer requirement raised to `^1.6.0` (relies on plugin `init()` options `databaseHooks` merging).

  **Fixes:**

  - Hosts with `emailAndPassword.requireEmailVerification: true` never fired `track.lead` — sign-up produces no session, and the old `ctx.context.newSession` gate dropped every credential signup. Lead attribution now requires no session.
  - OAuth signups needed the `/callback/` path matcher, which also re-shipped PII on every returning-user OAuth sign-in. The user-creation hook fires exactly once per new user, closing that leak class entirely.

  Unlike `dub-better-auth`, the click cookie is intentionally NOT cleared after the lead fires: host checkout flows may still read it for sale-side metadata, and the server dedupes leads on `(customerExternalId, eventName)`.
