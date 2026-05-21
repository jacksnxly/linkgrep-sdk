import Stripe from "stripe";
import { STRIPE_SECRET_KEY } from "$env/static/private";

export const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: "2026-04-22.dahlia" as never,
});

export async function createCheckoutSession(userId: string, priceId: string) {
  return stripe.checkout.sessions.create({
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
