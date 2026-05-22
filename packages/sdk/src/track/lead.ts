import type { HttpClient } from "../http/client.js";
import type {
  TrackLeadInput,
  TrackLeadResponse,
  TrackLeadWire,
} from "../types.js";
import {
  ConflictError,
  toResult,
  type LinkgrepError,
  type Result,
} from "../http/errors.js";

export interface LeadTracker {
  (input: TrackLeadInput): Promise<TrackLeadResponse>;
  safe(
    input: TrackLeadInput,
  ): Promise<Result<TrackLeadResponse, LinkgrepError | Error>>;
}

export function createLeadTracker(http: HttpClient): LeadTracker {
  function lead(input: TrackLeadInput): Promise<TrackLeadResponse> {
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
    // 409 → duplicate. Server returns no body on conflict; the SDK synthesizes
    // a marker so callers can branch on `result.duplicate` without parsing the
    // error envelope. Per-endpoint handling keeps the generic HttpClient honest
    // about the response type it returns.
    return http.post<TrackLeadResponse>("/api/track/lead", wire).catch((e) => {
      if (e instanceof ConflictError) {
        return { duplicate: true } satisfies TrackLeadResponse;
      }
      throw e;
    });
  }
  lead.safe = (input: TrackLeadInput) => toResult(lead(input));
  return lead as LeadTracker;
}
