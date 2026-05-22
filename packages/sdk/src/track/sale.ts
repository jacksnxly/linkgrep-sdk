import type { HttpClient } from "../http/client.js";
import type { TrackSaleInput, TrackSaleResponse } from "../types.js";
import {
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
    return http.post<TrackSaleResponse>("/api/track/sale", input);
  }
  sale.safe = (input: TrackSaleInput) => toResult(sale(input));
  return sale as SaleTracker;
}
