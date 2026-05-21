import type { HttpClient } from "../http/client.js";
import type {
  TrackLeadInput,
  TrackLeadResponse,
  TrackLeadWire,
} from "@linkgrep/types";

export function createLeadTracker(http: HttpClient) {
  return function lead(input: TrackLeadInput): Promise<TrackLeadResponse> {
    const {
      clickId,
      eventName,
      customerExternalId,
      customerEmail,
      customerName,
      mode,
      metadata,
      ...rest
    } = input;
    // Exhaustiveness guard: if a field is added to TrackLeadInput without
    // updating this translator, the line below fails to compile. Prevents
    // silent field drops in the anti-corruption layer.
    const _exhaustive: Record<string, never> = rest;
    void _exhaustive;

    const wire: TrackLeadWire = {
      clickId,
      eventName,
      customer: {
        externalId: customerExternalId,
        email: customerEmail,
        name: customerName,
      },
      // Do not change — server rejects "async"; Zod .default() never fires
      // because the SDK does not .parse() before sending.
      mode: mode ?? "fire-and-forget",
      metadata,
    };
    return http.post<TrackLeadResponse>("/api/track/lead", wire);
  };
}
