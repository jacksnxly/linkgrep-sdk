# Linkgrep SDK

The official JavaScript / TypeScript packages for [Linkgrep](https://linkgrep.xyz) — affiliate attribution and partner-commission tracking for modern SaaS.

Three small packages cover the full attribution loop: a browser bundle that captures the click, a server SDK that reports the lead and the sale, and a Better Auth plugin that wires it all together if you already use Better Auth.

```
   click (browser)              lead (server)             sale (server)
        │                              │                         │
        ▼                              ▼                         ▼
 @linkgrep/analytics    ──▶    linkgrep.track.lead   ──▶    linkgrep.track.sale
 (cookie capture)              (sign-up / signal)          (revenue event)
```

## Packages

| Package | Use it when… |
|---|---|
| [`linkgrep`](https://www.npmjs.com/package/linkgrep) | You're on the server (Node, Bun, Deno, Workers) and want to report a lead or a sale. |
| [`@linkgrep/analytics`](https://www.npmjs.com/package/@linkgrep/analytics) | You want a 1.1 KB browser script that captures the click ID from the URL into a cookie. Or you want the matching React hook. |
| [`@linkgrep/better-auth`](https://www.npmjs.com/package/@linkgrep/better-auth) | You use [Better Auth](https://better-auth.com) and want sign-ups, OAuth callbacks, and magic-link sign-ins to fire `track.lead` automatically. |

All three packages ship ESM and CJS, with TypeScript types. The browser bundle is also published as an immutable, versioned IIFE at `https://cdn.linkgrep.xyz/script/v0/script.js` if you'd rather load it via a `<script>` tag than bundle it.

## Quick start

### 1. Capture the click in the browser

When a partner links to your site with `?lg_id=...`, capture that ID into a cookie that survives until sign-up.

```bash
pnpm add @linkgrep/analytics
```

```ts
import { init } from "@linkgrep/analytics";

// Call once on every page (e.g. in your root layout / app.tsx).
init({
  // Optional. Set to ".example.com" if your sign-up flow lives on a different subdomain.
  cookieDomain: ".example.com",
});
```

Or load it from the CDN:

```html
<script async src="https://cdn.linkgrep.xyz/script/v0/script.js"></script>
```

### 2. Report the lead on the server

After your user signs up, hand the click ID to Linkgrep.

```bash
pnpm add linkgrep
```

```ts
import { Linkgrep } from "linkgrep";

const linkgrep = new Linkgrep({
  token: process.env.LINKGREP_API_KEY!,
});

// Inside your sign-up route, after you've created the user:
await linkgrep.track.lead({
  eventName: "Sign Up",
  customerExternalId: newUser.id,
  customerEmail: newUser.email,
  clickId: getClickIdFromCookie(req), // read the lgr_id cookie
});
```

Prefer not to throw on transport errors? Use the `.safe` variant — it returns a discriminated union instead.

```ts
const result = await linkgrep.track.lead.safe({ ... });
if (result.ok) {
  // result.data is the API response
} else {
  // result.error is a sealed LinkgrepError | LinkgrepNetworkError
}
```

### 3. Report the sale when revenue happens

Typically from a Stripe / Paddle / LemonSqueezy webhook.

```ts
await linkgrep.track.sale({
  amount: 9900, // cents
  currency: "USD",
  invoiceId: stripeInvoice.id, // doubles as the server-side idempotency key
  customerExternalId: user.id,
});
```

That's the whole loop. Click → cookie → lead → sale.

## Better Auth plugin

If your sign-up flow already runs through [Better Auth](https://better-auth.com), the plugin wires up step 2 for you — no manual `track.lead` calls.

```bash
pnpm add @linkgrep/better-auth
```

```ts
import { betterAuth } from "better-auth";
import { Linkgrep } from "linkgrep";
import { linkgrepAnalytics } from "@linkgrep/better-auth";

const linkgrep = new Linkgrep({ token: process.env.LINKGREP_API_KEY! });

export const auth = betterAuth({
  // ... your existing config
  plugins: [
    linkgrepAnalytics({
      client: linkgrep,
      // Fires from `databaseHooks.user.create.after` — once per new user,
      // for every signup surface (email/password, OAuth, magic link),
      // even when `requireEmailVerification` means no session exists yet.
      // Never fires on returning-user sign-in.
    }),
  ],
});
```

The plugin reads the `lgr_id` click cookie from the signup request (no cookie → no referral → nothing is sent), fires `track.lead.safe` in the background, and never blocks the auth response. Failed dispatches surface through an optional `onError(error)` hook so you can route them to Sentry / Datadog / Honeycomb.

## React hook

If you're on React, there's a thin hook that calls `init()` exactly once and exposes the current click ID.

```bash
pnpm add @linkgrep/analytics
```

```tsx
import { useLinkgrep } from "@linkgrep/analytics/react";

function App() {
  const { clickId } = useLinkgrep({ cookieDomain: ".example.com" });
  // clickId is whatever ?lg_id=... captured, or undefined.
}
```

## Full example app

A working SvelteKit + Better Auth + Stripe reference integration lives at [`examples/sveltekit-better-auth-stripe`](./examples/sveltekit-better-auth-stripe). It shows:

- The browser cookie write
- A `/lgr` proxy hardened against SSRF (so customer sites can serve the IIFE from their own origin without CORS)
- A Stripe webhook firing `track.sale` after `checkout.session.completed`
- The Better Auth plugin wired into the auth handler

It's the canonical "putting it all together" reference. Open the example's source the first time you set this up.

## Errors

The SDK has a sealed error taxonomy — one class per HTTP error code, one for transport failures, all with structured fields (`code`, `status`, `requestId`, `docUrl`, `headers`).

```ts
import { LinkgrepError, RateLimitError } from "linkgrep";

try {
  await linkgrep.track.lead({ ... });
} catch (e) {
  if (e instanceof RateLimitError) {
    // e.retryAfter is parsed from the Retry-After header (delta-seconds, HTTP-date, or ISO-8601)
  } else if (e instanceof LinkgrepError) {
    // Any structured Linkgrep API error — log e.code, e.status, e.requestId
  }
  // Anything else is a programmer bug — let it propagate.
}
```

For one-line structured logging across `track.lead` and `track.sale` call sites, there's `formatTrackError` — used by the Better Auth plugin's fallback and safe to use yourself:

```ts
import { formatTrackError } from "linkgrep";

const result = await linkgrep.track.lead.safe({ ... });
if (!result.ok) {
  console.warn(formatTrackError("track.lead", result.error));
  // [linkgrep] track.lead failed: code=unprocessable status=422 requestId="…" docUrl="…" message="…"
}
```

The format is logfmt-compatible — Sentry / Datadog / Honeycomb / Loki scrapers extract every field as a structured tag.

## Retries, timeouts, and cancellation

Sensible defaults:

- **Per-attempt timeout:** 10 seconds (`timeoutMs`)
- **Retry policy:** exponential backoff + jitter, honors `Retry-After`, surfaces lastError when the total budget is exhausted
- **AbortSignal:** pass `signal` on the `Linkgrep` constructor to cancel mid-call, mid-retry

```ts
const linkgrep = new Linkgrep({
  token: process.env.LINKGREP_API_KEY!,
  timeoutMs: 5_000,
  retry: { maxAttempts: 3, totalBudgetMs: 15_000 },
});
```

You can also swap the underlying `fetch` — useful for Cloudflare Workers bindings, [`undici.Agent`](https://undici.nodejs.org/) connection pooling, or test stubs.

## Repo layout

```
linkgrep-sdk/
├── packages/
│   ├── sdk/                    ← linkgrep
│   ├── analytics/              ← @linkgrep/analytics (+ /react entry, /script IIFE)
│   └── better-auth/            ← @linkgrep/better-auth
├── examples/
│   └── sveltekit-better-auth-stripe/   ← reference integration
└── .github/workflows/          ← CI + npm + CDN release pipelines
```

## Development

```bash
pnpm install
pnpm build       # tsup across all 3 packages
pnpm test        # vitest, ~90 tests
pnpm typecheck   # tsc --noEmit on each package
pnpm lint        # Biome — formatting + lint in one pass
pnpm format      # Biome with --write to auto-fix
pnpm check       # lint + typecheck + test, the pre-release gate
```

Node 22+ and pnpm 10+ required (the `packageManager` field locks pnpm).

## Releasing

Day-to-day, [changesets](https://github.com/changesets/changesets) drives versioning. To propose a release:

```bash
pnpm changeset           # interactive — pick which packages bumped and the type
git commit -am "chore: changeset"
git push
```

The `release.yml` workflow opens a "Version Packages" PR. Merging that PR triggers `pnpm release`, which builds and publishes via npm Trusted Publishing (OIDC — no `NPM_TOKEN` required), then dispatches `publish-cdn.yml` to push the analytics IIFE to `cdn.linkgrep.xyz`.

For the very first release of a fresh package (no `Trusted Publishing` configured on npmjs.com yet), you can publish manually:

```bash
pnpm -r publish --no-git-checks --access public
```

## Contributing

The codebase is small and self-contained. Open an issue describing the problem before sending a PR for anything beyond a typo — there's usually context worth surfacing first.

Style is enforced by Biome (`pnpm lint` / `pnpm format`); tests run on every push via GitHub Actions; required-status-check is the `test` job in `ci.yml`.

## Links

- 🌐 Website: [linkgrep.xyz](https://linkgrep.xyz)
- 📦 npm: [`linkgrep`](https://www.npmjs.com/package/linkgrep) · [`@linkgrep/analytics`](https://www.npmjs.com/package/@linkgrep/analytics) · [`@linkgrep/better-auth`](https://www.npmjs.com/package/@linkgrep/better-auth)
- 🐛 Issues: [github.com/jacksnxly/linkgrep-sdk/issues](https://github.com/jacksnxly/linkgrep-sdk/issues)
