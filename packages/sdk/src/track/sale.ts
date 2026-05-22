import type { HttpClient } from "../http/client.js";
import type {
  TrackSaleInput,
  TrackSaleResponse,
  TrackSaleWire,
} from "../types.js";
import {
  mapConflict,
  toResult,
  type LinkgrepError,
  type LinkgrepNetworkError,
  type Result,
} from "../http/errors.js";

export interface SaleTracker {
  (input: TrackSaleInput): Promise<TrackSaleResponse>;
  safe(
    input: TrackSaleInput,
  ): Promise<Result<TrackSaleResponse, LinkgrepError | LinkgrepNetworkError>>;
}

export function createSaleTracker(http: HttpClient): SaleTracker {
  function sale(input: TrackSaleInput): Promise<TrackSaleResponse> {
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
    return mapConflict(http.post<TrackSaleResponse>("/api/track/sale", wire));
  }
  sale.safe = (input: TrackSaleInput) => toResult(sale(input));
  return sale as SaleTracker;
}
