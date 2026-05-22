import { json, type RequestHandler } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";
import { auth } from "$lib/server/auth";
import { createCheckoutSession } from "$lib/server/stripe";

// Server-side checkout endpoint. The lgCustomerExternalId MUST come from the
// authenticated session, never from the request body — accepting it from the
// client lets an attacker attribute conversions to any user (commission /
// attribution spoofing). better-auth canonical session lookup:
// https://www.better-auth.com/docs/integrations/svelte-kit
export const POST: RequestHandler = async ({ request }) => {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as { priceId?: string };
  if (!body.priceId) {
    return json({ error: "priceId required" }, { status: 400 });
  }

  const lgCustomerExternalId = session.user.id;

  // When STRIPE_SECRET_KEY is unset (dev / demo / CI), short-circuit with a
  // stub URL so the rest of the example app remains runnable without Stripe
  // credentials. In production deployments, set STRIPE_SECRET_KEY and the
  // real Checkout Session is created. The lgCustomerExternalId is returned
  // in both branches so the e2e regression at `attribution.spec.ts` still
  // verifies the server-derived identifier reaches the response.
  if (!env.STRIPE_SECRET_KEY) {
    return json({ url: "/success", lgCustomerExternalId });
  }

  const stripeSession = await createCheckoutSession(lgCustomerExternalId, body.priceId);
  return json({ url: stripeSession.url, lgCustomerExternalId });
};
