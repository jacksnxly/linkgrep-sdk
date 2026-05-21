import type { HttpClient } from "../http/client.js";
import type {
  TrackLeadInput,
  TrackLeadResponse,
  TrackLeadWire,
} from "@linkgrep/types";

export function createLeadTracker(http: HttpClient) {
  return function lead(input: TrackLeadInput): Promise<TrackLeadResponse> {
    const wire: TrackLeadWire = {
      clickId: input.clickId,
      eventName: input.eventName,
      customer: {
        externalId: input.customerExternalId,
        email: input.customerEmail,
        name: input.customerName,
      },
      mode: input.mode ?? "fire-and-forget",
      metadata: input.metadata,
    };
    return http.post<TrackLeadResponse>("/api/track/lead", wire);
  };
}
