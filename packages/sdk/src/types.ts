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

// ---------- Branded ID types (D5) ----------
// Nominal type-safety for the four externally-distinct linkgrep IDs.
// Canonical TypeScript branded-type pattern (`T & { __brand: K }`) — see
// https://www.learningtypescript.com/articles/branded-types and the
// well-documented "Mars Climate Orbiter" unit-confusion class of bugs.
//
// All four brands are structurally `string` at runtime — passing them to
// any `string` API works without conversion. The brands fire ONLY at the
// type checker, where they prevent the canonical foot-guns: passing a
// CustomerId where a CustomerExternalId is expected, or a ClickId where a
// CommissionId is expected, etc.
//
// Consumers obtain branded values via the `as*` helpers (asClickId,
// asCustomerExternalId, asCustomerId, asInvoiceId). Inputs continue to
// accept plain `string`; the brands flow OUT of responses for downstream
// type-safety in attribution chains.
export type ClickId = string & { readonly __brand: "ClickId" };
export type CustomerExternalId = string & { readonly __brand: "CustomerExternalId" };
export type CustomerId = string & { readonly __brand: "CustomerId" };
export type InvoiceId = string & { readonly __brand: "InvoiceId" };

/** Opt-in brand helper. The runtime is a no-op; the brand is a TS-only marker. */
export const asClickId = (s: string): ClickId => s as ClickId;
/** Opt-in brand helper. The runtime is a no-op; the brand is a TS-only marker. */
export const asCustomerExternalId = (s: string): CustomerExternalId => s as CustomerExternalId;
/** Opt-in brand helper. The runtime is a no-op; the brand is a TS-only marker. */
export const asCustomerId = (s: string): CustomerId => s as CustomerId;
/** Opt-in brand helper. The runtime is a no-op; the brand is a TS-only marker. */
export const asInvoiceId = (s: string): InvoiceId => s as InvoiceId;

// ---------- Public SDK input (flat, ergonomic) ----------
export interface TrackLeadInput {
  /** Click attribution token (from cookie `lgr_id` or `?lg_id=`). Brand: ClickId. */
  clickId?: ClickId | string;
  eventName: string;
  /** Your own user/customer identifier. Brand: CustomerExternalId. */
  customerExternalId: CustomerExternalId | string;
  customerName?: string;
  customerEmail?: string;
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

// ---------- Lead response (server may include attribution chain) ----------
// Duplicate (HTTP 409) outcome is modeled as a separate branch in
// `TrackLeadResult` (see track/lead.ts) instead of as an optional field on
// this shape, so the discriminated union narrows cleanly via `"duplicate" in r`.
//
// IDs carry brand types out of responses so consumers can pipe a `CustomerId`
// or `ClickId` into a follow-up SDK call and the type checker prevents
// accidental swaps with other ID-shaped strings. Brands are structurally
// `string`; existing code that destructures `customerId` into a plain
// `string` keeps working.
export interface TrackLeadResponse {
  customerId?: CustomerId;
  clickId?: ClickId;
  partnerId?: string;
  programId?: string;
  commissionId?: string;
  commissionAmount?: number;
}

// ---------- Sale input (flat ergonomic shape consumers pass) ----------
// `paymentProcessor` and `eventName` are NOT accepted by the server — do not
// add. The compile-time exhaustiveness guard in track/sale.ts catches drift.
export interface TrackSaleInput {
  /** Click attribution token. Brand: ClickId. */
  clickId?: ClickId | string;
  /** Your own user/customer identifier. Brand: CustomerExternalId. */
  customerExternalId?: CustomerExternalId | string;
  amount: number;
  currency?: string;
  /** Invoice identifier — server's idempotency key. Brand: InvoiceId. */
  invoiceId?: InvoiceId | string;
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
