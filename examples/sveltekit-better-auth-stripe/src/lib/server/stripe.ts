import Stripe from "stripe";
import { env } from "$env/dynamic/private";

// Lazy: don't construct the Stripe client at import time. Matches the
// pattern used in `auth.ts` — build-time module evaluation (SvelteKit
// prerender / `vite build`) imports this module but never touches env.
// The instance is constructed the first time a request actually needs it.
let _stripe: Stripe | undefined;
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  _stripe = new Stripe(key);
  return _stripe;
}

/**
 * Read the Stripe webhook endpoint secret used to verify
 * `Stripe-Signature` headers. Lazy so the build doesn't require the secret
 * to be present — the running server refuses webhook traffic without it.
 */
export function getWebhookSecret(): string {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
  return secret;
}

/**
 * Wraps `stripe.webhooks.constructEvent` — the canonical pattern for
 * verifying Stripe-signed webhook payloads:
 * https://docs.stripe.com/webhooks/signature.
 *
 * Throws `Stripe.errors.StripeSignatureVerificationError` on signature
 * mismatch; the caller maps to a 400.
 */
export function constructWebhookEvent(
  rawBody: string,
  signatureHeader: string,
): Stripe.Event {
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, getWebhookSecret());
}

/**
 * Create a Stripe Checkout Session for a subscription. The user's linkgrep
 * customer identifier flows in TWO places so attribution survives the
 * checkout-to-webhook round trip:
 *
 *   1. `client_reference_id` — Stripe's recommended idempotency key for
 *      linking a Checkout Session back to your own user record.
 *   2. `metadata.lgCustomerExternalId` — explicit, attribution-domain
 *      identifier the webhook reads to call `linkgrep.track.sale`.
 *   3. `subscription_data.metadata.lgCustomerExternalId` — mirror on the
 *      subscription so recurring invoices still carry the identifier when
 *      `invoice.payment_succeeded` fires later.
 */
export async function createCheckoutSession(userId: string, priceId: string) {
  return getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${env.AUTH_BASE_URL ?? "http://localhost:5173"}/success`,
    cancel_url: `${env.AUTH_BASE_URL ?? "http://localhost:5173"}/cancel`,
    client_reference_id: userId,
    metadata: {
      lgCustomerExternalId: userId,
    },
    subscription_data: {
      metadata: {
        lgCustomerExternalId: userId,
      },
    },
  });
}
