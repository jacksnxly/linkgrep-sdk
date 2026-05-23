import type { HttpClient } from "../http/client.js";
import {
  assertResponseObject,
  type LinkgrepError,
  type LinkgrepNetworkError,
  mapConflict,
  type Result,
  toResult,
} from "../http/errors.js";
import type { TrackLeadInput, TrackLeadResponse, TrackLeadWire } from "../types.js";

/**
 * Track.lead result is a discriminated union: the server's `TrackLeadResponse`
 * shape for the normal path, or `{ duplicate: true }` synthesized by
 * mapConflict on HTTP 409. Consumers narrow via the `duplicate` flag:
 *
 *   const r = await client.track.lead(input);
 *   if ("duplicate" in r && r.duplicate) { ... } else { use r.customerId, ... }
 *
 * Pre-D2 the public type was just `TrackLeadResponse`, which silently masked
 * a duplicate result as a base response with all fields undefined.
 */
export type TrackLeadResult = TrackLeadResponse | { duplicate: true };

export interface LeadTracker {
  (input: TrackLeadInput): Promise<TrackLeadResult>;
  safe(
    input: TrackLeadInput,
  ): Promise<Result<TrackLeadResult, LinkgrepError | LinkgrepNetworkError>>;
}

/**
 * Default `mode` selection when the caller omits it: with a `clickId`, the
 * attribution can resolve immediately so the server can fire-and-forget;
 * without one, it must defer until a later click match arrives. Moving the
 * rule into the SDK (was previously in `@linkgrep/better-auth`, keryx I-14)
 * means every adapter package (NextAuth, Lucia, Hono, …) inherits the same
 * domain semantics without rediscovering them. Callers can still pass an
 * explicit `mode` to override.
 */
function defaultMode(clickId: string | undefined): "fire-and-forget" | "deferred" {
  return clickId ? "fire-and-forget" : "deferred";
}

export function createLeadTracker(http: HttpClient): LeadTracker {
  function lead(input: TrackLeadInput): Promise<TrackLeadResult> {
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
      mode: mode ?? defaultMode(clickId),
      metadata,
    };
    // Reverse-direction ACL guard (keryx I-16): every TrackLeadWire field
    // must be acknowledged in this constructor. Adding a wire-only field
    // without populating it here is a compile error — the Record literal
    // below has to list every key, and TS rejects missing keys.
    const _wireKeysCovered: Record<keyof TrackLeadWire, true> = {
      clickId: true,
      eventName: true,
      customer: true,
      mode: true,
      metadata: true,
    };
    void _wireKeysCovered;
    // 409 → duplicate. Server returns no body on conflict; the SDK synthesizes
    // a marker so callers can branch on `result.duplicate` without parsing the
    // error envelope. See http/errors.ts:mapConflict for the shared translation.
    // assertResponseObject validates that the server's success body is a
    // JSON object (not array / primitive) before downstream consumers cast
    // it into `TrackLeadResponse` (keryx I-12).
    return mapConflict(
      http.post<unknown>("/api/track/lead", wire).then((parsed): TrackLeadResponse => {
        assertResponseObject(parsed, "/api/track/lead");
        return parsed as TrackLeadResponse;
      }),
    );
  }
  // Build the LeadTracker object explicitly via Object.assign so TS verifies
  // the `.safe` member is attached. The pre-D2 pattern (`return lead as
  // LeadTracker;`) cast the property in without type-checking it; if `lead.safe
  // = ...` were ever removed in a refactor the cast would keep compiling but
  // `.safe` would be missing at runtime.
  return Object.assign(lead, {
    safe: (input: TrackLeadInput) => toResult(lead(input)),
  });
}
