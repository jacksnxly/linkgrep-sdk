import { json, type RequestHandler } from "@sveltejs/kit";

// Minimal checkout endpoint. Reads { priceId, lgCustomerExternalId } and
// (in a real app) calls stripe.checkout.sessions.create with that metadata.
// The e2e test mocks this endpoint, so we only need to mirror the contract.
export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json()) as {
    priceId?: string;
    lgCustomerExternalId?: string;
  };
  if (!body.priceId || !body.lgCustomerExternalId) {
    return json({ error: "priceId and lgCustomerExternalId required" }, { status: 400 });
  }
  // Real implementation:
  //   const session = await createCheckoutSession(body.lgCustomerExternalId, body.priceId);
  //   return json({ url: session.url });
  return json({ url: "/success" });
};
