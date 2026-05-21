import type { HttpClient } from "../http/client.js";
import type { TrackSaleInput, TrackSaleResponse } from "@linkgrep/types";

export function createSaleTracker(http: HttpClient) {
  return function sale(input: TrackSaleInput): Promise<TrackSaleResponse> {
    return http.post<TrackSaleResponse>("/api/track/sale", input);
  };
}
