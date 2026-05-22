import { json, type RequestHandler } from "@sveltejs/kit";
import { auth } from "$lib/server/auth";

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
  // Real implementation:
  //   const stripeSession = await createCheckoutSession(lgCustomerExternalId, body.priceId);
  //   return json({ url: stripeSession.url });
  return json({ url: "/success", lgCustomerExternalId });
};
