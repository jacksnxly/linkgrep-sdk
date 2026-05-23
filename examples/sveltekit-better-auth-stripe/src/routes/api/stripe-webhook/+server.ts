import { type RequestHandler } from "@sveltejs/kit";
import type Stripe from "stripe";
import { constructWebhookEvent } from "$lib/server/stripe";
import { getLinkgrep, logTrackError } from "$lib/server/linkgrep";

// Stripe webhook endpoint — closes the linkgrep attribution loop by calling
// `track.sale` when a Stripe checkout completes. This demonstrates the second
// half of the canonical attribution flow that the analytics + better-auth
// pieces only half-cover (keryx I-9 — pre-fix, `lib/server/stripe.ts` was
// dead code and the demo never called `track.sale`).
//
// Canonical signature-verification pattern: docs.stripe.com/webhooks/signature
//   const event = stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret);
//
// `request.text()` returns the raw body BEFORE any JSON parse — necessary
// because Stripe's signature is computed over the raw bytes; mutating the
// body (whitespace, key order) breaks verification.
//
// Linkgrep client + structured error logging are consumed from the shared
// composition root at $lib/server/linkgrep — the same client `auth.ts`
// uses for lead-tracking — so token/baseUrl/retry/fetch config can never
// drift between the lead and sale halves of attribution.

export const POST: RequestHandler = async ({ request }) => {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing Stripe-Signature header", { status: 400 });

  const rawBody = await request.text();

  let event: Stripe.Event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (err) {
    // StripeSignatureVerificationError or "STRIPE_WEBHOOK_SECRET not
    // configured" — both surface as 400 so Stripe retries with backoff
    // (vs 500 which would invite indefinite redelivery).
    const message = err instanceof Error ? err.message : "unknown";
    return new Response(`Webhook signature verification failed: ${message}`, { status: 400 });
  }

  // Two event types carry the linkgrep attribution metadata:
  //   - checkout.session.completed — fires once at the end of Checkout
  //   - invoice.payment_succeeded — fires on every recurring subscription
  //     renewal; relies on `subscription_data.metadata` carrying through
  //
  // For the example we handle only the first; production deployments will
  // want to handle invoice.payment_succeeded too for subscription renewals.
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    // Stripe types: `metadata: Stripe.Metadata | null` where `Metadata` is
    // `{[k: string]: string}`, and `client_reference_id: string | null`.
    // Both can be falsy via `null` (not just `undefined`); the chained `??`
    // coalesces both. No casts needed — the pre-fix `as string | undefined`
    // lied about null vs undefined (keryx 2026-05-23, finding M3).
    const lgCustomerExternalId: string | undefined =
      session.metadata?.lgCustomerExternalId ??
      session.client_reference_id ??
      undefined;
    // Stripe Checkout sessions in subscription mode populate `amount_total`
    // and `currency` after the session completes. The session's `id` is a
    // stable idempotency key — track.sale uses `invoiceId` as its Redis-NX
    // dedup key, so passing `session.id` here ensures retries of this
    // webhook don't double-record the sale.
    //
    // Fire-and-forget dispatch (keryx issue #1, 2026-05-23). Stripe's
    // webhook delivery client times out short of our worst-case retry
    // budget (defaults: maxAttempts=3 × timeoutMs=10_000 + backoffs ≈
    // 33 s under degraded-but-not-dead upstream). Awaiting track.sale
    // before the 200 ack would invite redelivery storms. Per Stripe's
    // official guidance (https://docs.stripe.com/webhooks —
    // "Quickly return a 2xx response ... prior to any complex logic
    // that might cause a timeout"), we ack first and dispatch the
    // attribution call as a background task.
    //
    // This mirrors `@linkgrep/better-auth`'s own `runInBackground`
    // shape (packages/better-auth/src/plugin.ts:96) so the example
    // demonstrates one consistent ack-first idiom across the codebase.
    // On Node hosts the dispatched promise keeps the event loop alive
    // until it settles; on adapter-cloudflare-workers consumers should
    // wrap this in `event.platform?.ctx?.waitUntil(...)` to survive
    // the response-close boundary.
    if (lgCustomerExternalId && typeof session.amount_total === "number") {
      void getLinkgrep()
        .track.sale.safe({
          invoiceId: session.id,
          customerExternalId: lgCustomerExternalId,
          amount: session.amount_total,
          currency: session.currency ?? undefined,
        })
        .then((r) => {
          if (!r.ok) logTrackError("track.sale", r.error);
        })
        .catch((e) => {
          // Defensive — .safe() is documented to never throw, but guard
          // against unhandled-rejection-crashes-the-process if that
          // contract is ever broken.
          logTrackError("track.sale", e);
        });
    }
  }

  // ack — Stripe stops retrying on any 2xx. The dispatched track.sale
  // call continues in the background regardless of this response.
  return new Response(null, { status: 200 });
};
