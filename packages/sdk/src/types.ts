// Public SDK types — inlined from the (deleted) @linkgrep/types workspace package.
// Kept as plain TypeScript interfaces; the SDK never .parse()s, so Zod was
// dropped to shrink installed bytes for consumers.
//
// Authoritative server schemas live in a SEPARATE repository:
//   https://github.com/linkgrep/linkgrep/blob/main/apps/web/app/api/track/schemas.ts
//
// There is no automated drift check today. When the server schemas change,
// these types must be updated by hand. If you find a field documented on the
// server but missing here, file an issue — and consider adding a contract
// test against the server's OpenAPI / schema snapshot.

// ---------- ID types ----------
// IDs are plain `string` on both inputs and outputs. The pre-fix branded
// types (`string & { __brand: "ClickId" }`) didn't fire on inputs because
// every input field was `Brand | string` — the `| string` arm neutered the
// brand on the call site (keryx I-7, validated 2026-05-22T1455Z). Removing
// brands matches the mature-SDK precedent in JS-land: AWS SDK, Stripe SDK,
// OpenAI SDK, Resend, and Vercel SDK all use plain `string` for IDs. The
// `as*` helpers and `__brand` markers are gone.

// ---------- Public SDK input (flat, ergonomic) ----------
export interface TrackLeadInput {
  /** Click attribution token (from cookie `lgr_id` or `?lg_id=`). */
  clickId?: string;
  eventName: string;
  /** Your own user/customer identifier. */
  customerExternalId: string;
  customerName?: string;
  customerEmail?: string;
  /**
   * Server-side processing mode. Defaults to `"fire-and-forget"` when a
   * `clickId` is present (the attribution can resolve immediately) and
   * `"deferred"` when it isn't (the server must await a later click match).
   * Override only when you know what you want.
   *
   * - `"wait"`         — block until the server resolves attribution
   * - `"fire-and-forget"` — server processes asynchronously; SDK returns immediately
   * - `"deferred"`     — server stores the lead and waits for a future click match
   */
  mode?: "wait" | "fire-and-forget" | "deferred";
  metadata?: Record<string, unknown>;
}

// ---------- HTTP wire shape (matches linkgrep server schema) ----------
export interface TrackLeadWire {
  clickId?: string;
  eventName: string;
  customer: {
    externalId?: string;
    email?: string;
    name?: string;
  };
  mode: "wait" | "fire-and-forget" | "deferred";
  metadata?: Record<string, unknown>;
}

// ---------- Lead response ----------
// Duplicate (HTTP 409) outcome is modeled as a separate branch in
// `TrackLeadResult` (see track/lead.ts) instead of as an optional field on
// this shape, so the discriminated union narrows cleanly via `"duplicate" in r`.
export interface TrackLeadResponse {
  customerId?: string;
  clickId?: string;
  partnerId?: string;
  programId?: string;
  commissionId?: string;
  commissionAmount?: number;
}

// ---------- Sale input (flat ergonomic shape consumers pass) ----------
// `paymentProcessor` and `eventName` are NOT accepted by the server — do not
// add. The compile-time exhaustiveness guard in track/sale.ts catches drift.
//
// At least one of `clickId`, `invoiceId`, or `customerExternalId` MUST be
// supplied (keryx I-15, 2026-05-22T1455Z — the asymmetry vs Lead is
// intentional). Lead requires `customerExternalId` because the linkgrep
// server uses it to create the customer record at attribution-resolution
// time; Sale can attribute via any of the three because the customer
// already exists (it was created by a prior Lead or via the dashboard).
// The SDK does NOT enforce the "at least one" rule at compile time — modeling
// it as a discriminated union (`SaleByClick | SaleByInvoice | SaleByCustomer`)
// would force every caller into a tagged union shape that few real workloads
// have. The server rejects a Sale with all three omitted; consumers see a
// `BadRequestError` with `code: "bad_request"`.
export interface TrackSaleInput {
  /** Click attribution token. */
  clickId?: string;
  /** Your own user/customer identifier. */
  customerExternalId?: string;
  amount: number;
  currency?: string;
  /** Invoice identifier — server's idempotency key (Redis SET NX, 7-day TTL). */
  invoiceId?: string;
  leadEventName?: string;
  metadata?: Record<string, unknown>;
}

// ---------- Sale wire shape (matches linkgrep server schema) ----------
// Currently 1:1 with TrackSaleInput but maintained as a separate type so the
// destructure-then-translate seam in track/sale.ts is explicit and the wire
// contract can evolve independently of the public input shape.
export interface TrackSaleWire {
  clickId?: string;
  customerExternalId?: string;
  amount: number;
  currency?: string;
  invoiceId?: string;
  leadEventName?: string;
  metadata?: Record<string, unknown>;
}

// Duplicate (HTTP 409) outcome is modeled as a separate branch in
// `TrackSaleResult` (see track/sale.ts) instead of as an optional field on
// this shape, so the discriminated union narrows cleanly via `"duplicate" in r`.
export interface TrackSaleResponse {
  commissionId?: string;
  commissionAmount?: number;
  status?: string;
}
