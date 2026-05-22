import type { HttpClient } from "../http/client.js";
import type { TrackSaleInput, TrackSaleResponse } from "../types.js";
import {
  ConflictError,
  toResult,
  type LinkgrepError,
  type Result,
} from "../http/errors.js";

export interface SaleTracker {
  (input: TrackSaleInput): Promise<TrackSaleResponse>;
  safe(
    input: TrackSaleInput,
  ): Promise<Result<TrackSaleResponse, LinkgrepError | Error>>;
}

export function createSaleTracker(http: HttpClient): SaleTracker {
  function sale(input: TrackSaleInput): Promise<TrackSaleResponse> {
    // 409 → duplicate. See track/lead.ts for rationale.
    return http.post<TrackSaleResponse>("/api/track/sale", input).catch((e) => {
      if (e instanceof ConflictError) {
        return { duplicate: true } satisfies TrackSaleResponse;
      }
      throw e;
    });
  }
  sale.safe = (input: TrackSaleInput) => toResult(sale(input));
  return sale as SaleTracker;
}
