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

// ---------- Public SDK input (flat, ergonomic) ----------
export interface TrackLeadInput {
  clickId?: string;
  eventName: string;
  customerExternalId: string;
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
export interface TrackLeadResponse {
  customerId?: string;
  clickId?: string;
  partnerId?: string;
  programId?: string;
  commissionId?: string;
  commissionAmount?: number;
  // Synthesized client-side on HTTP 409 — the server returns no body.
  duplicate?: boolean;
}

// ---------- Sale input (flat ergonomic shape consumers pass) ----------
// `paymentProcessor` and `eventName` are NOT accepted by the server — do not
// add. The compile-time exhaustiveness guard in track/sale.ts catches drift.
export interface TrackSaleInput {
  clickId?: string;
  customerExternalId?: string;
  amount: number;
  currency?: string;
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

export interface TrackSaleResponse {
  commissionId?: string;
  commissionAmount?: number;
  status?: string;
  // Synthesized client-side on HTTP 409 — the server returns no body.
  duplicate?: boolean;
}
