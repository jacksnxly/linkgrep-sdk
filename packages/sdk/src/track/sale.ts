import type { HttpClient } from "../http/client.js";
import type {
  TrackSaleInput,
  TrackSaleResponse,
  TrackSaleWire,
} from "../types.js";
import {
  assertResponseObject,
  mapConflict,
  toResult,
  type LinkgrepError,
  type LinkgrepNetworkError,
  type Result,
} from "../http/errors.js";

/**
 * Track.sale result is a discriminated union: the server's `TrackSaleResponse`
 * shape for the normal path, or `{ duplicate: true }` synthesized by
 * mapConflict on HTTP 409. Consumers narrow via the `duplicate` flag:
 *
 *   const r = await client.track.sale(input);
 *   if ("duplicate" in r && r.duplicate) { ... } else { use r.commissionId, ... }
 *
 * Pre-D2 the public type was just `TrackSaleResponse`, which silently masked
 * a duplicate result as a base response with all fields undefined.
 */
export type TrackSaleResult = TrackSaleResponse | { duplicate: true };

export interface SaleTracker {
  (input: TrackSaleInput): Promise<TrackSaleResult>;
  safe(
    input: TrackSaleInput,
  ): Promise<Result<TrackSaleResult, LinkgrepError | LinkgrepNetworkError>>;
}

export function createSaleTracker(http: HttpClient): SaleTracker {
  function sale(input: TrackSaleInput): Promise<TrackSaleResult> {
    const {
      clickId,
      customerExternalId,
      amount,
      currency,
      invoiceId,
      leadEventName,
      metadata,
      ...rest
    } = input;
    // Exhaustiveness guard: if a field is added to TrackSaleInput without
    // updating this translator, the line below fails to compile. Mirrors
    // track/lead.ts:36 so both track endpoints share the same compile-time
    // anti-corruption-layer discipline against silent wire drift.
    const _exhaustive: Record<string, never> = rest;
    void _exhaustive;

    const wire: TrackSaleWire = {
      clickId,
      customerExternalId,
      amount,
      currency,
      invoiceId,
      leadEventName,
      metadata,
    };
    // Reverse-direction ACL guard (keryx I-16): mirrors track/lead.ts.
    // Adding a TrackSaleWire field without listing it here is a compile error.
    const _wireKeysCovered: Record<keyof TrackSaleWire, true> = {
      clickId: true,
      customerExternalId: true,
      amount: true,
      currency: true,
      invoiceId: true,
      leadEventName: true,
      metadata: true,
    };
    void _wireKeysCovered;
    // Lightweight shape guard at the parse seam (keryx I-12) — see
    // track/lead.ts for rationale.
    return mapConflict(
      http.post<unknown>("/api/track/sale", wire).then((parsed): TrackSaleResponse => {
        assertResponseObject(parsed, "/api/track/sale");
        return parsed as TrackSaleResponse;
      }),
    );
  }
  // Object.assign mirror of track/lead.ts — type-checks the .safe attachment
  // instead of relying on an unsafe `as SaleTracker` cast (keryx C2).
  return Object.assign(sale, {
    safe: (input: TrackSaleInput) => toResult(sale(input)),
  });
}
