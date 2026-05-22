import Stripe from "stripe";
import { env } from "$env/dynamic/private";

// Lazy: don't construct the Stripe client at import time. The demo's
// /create-checkout endpoint doesn't actually call Stripe (returns a stub
// URL); production users should swap the lazy getter for an eager
// import with a `$env/static/private` STRIPE_SECRET_KEY.
let _stripe: Stripe | undefined;
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY not configured");
  _stripe = new Stripe(key);
  return _stripe;
}

export async function createCheckoutSession(userId: string, priceId: string) {
  return getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: "http://localhost:5173/success",
    cancel_url: "http://localhost:5173/cancel",
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
