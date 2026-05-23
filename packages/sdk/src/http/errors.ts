/**
 * Server-emitted error codes. Strict literal union — consumers writing
 * `switch (err.code) { case "rate_limited": ... }` get full
 * exhaustiveness checking via the canonical TS `never`-sentinel pattern
 * (TypeScript handbook → Narrowing → Exhaustiveness checking).
 *
 * Server-emitted codes outside this list become `"unknown"` at the
 * `parseErrorResponse` seam (errors.ts:209-211 logic), preserving the
 * raw envelope on `.raw` so consumers can still introspect. This trades
 * the previous `(string & {})` forward-compat arm — which silently
 * widened to `string` and defeated exhaustiveness — for an explicit
 * "unknown" funnel that consumers can branch on.
 */
export type LinkgrepErrorCode =
  | "bad_request"
  | "unauthorized"
  | "permission_denied"
  | "not_found"
  | "conflict"
  | "gone"
  | "unprocessable"
  | "rate_limited"
  | "internal_error"
  | "unknown";

const KNOWN_ERROR_CODES: ReadonlySet<LinkgrepErrorCode> = new Set([
  "bad_request",
  "unauthorized",
  "permission_denied",
  "not_found",
  "conflict",
  "gone",
  "unprocessable",
  "rate_limited",
  "internal_error",
  "unknown",
]);

export interface LinkgrepErrorInit {
  status: number;
  code: LinkgrepErrorCode;
  message: string;
  docUrl?: string;
  requestId?: string;
  raw: unknown;
  headers: Headers;
}

export class LinkgrepError extends Error {
  readonly status: number;
  readonly code: LinkgrepErrorCode;
  readonly docUrl?: string;
  readonly requestId?: string;
  readonly raw: unknown;
  readonly headers: Headers;

  constructor(init: LinkgrepErrorInit) {
    super(init.message);
    this.name = "LinkgrepError";
    this.status = init.status;
    this.code = init.code;
    this.docUrl = init.docUrl;
    this.requestId = init.requestId;
    this.raw = init.raw;
    this.headers = init.headers;
  }
}

export class BadRequestError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "BadRequestError";
  }
}
export class AuthenticationError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "AuthenticationError";
  }
}
export class PermissionError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "PermissionError";
  }
}
export class NotFoundError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "NotFoundError";
  }
}
export class ConflictError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "ConflictError";
  }
}
export class GoneError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "GoneError";
  }
}
export class UnprocessableEntityError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "UnprocessableEntityError";
  }
}
export class RateLimitError extends LinkgrepError {
  readonly retryAfter?: number;
  constructor(init: LinkgrepErrorInit & { retryAfter?: number }) {
    super(init);
    this.name = "RateLimitError";
    this.retryAfter = init.retryAfter;
  }
}
export class InternalServerError extends LinkgrepError {
  constructor(i: LinkgrepErrorInit) {
    super(i);
    this.name = "InternalServerError";
  }
}

/**
 * Transport-layer failure surfaced to `.safe()` callers as part of a sealed
 * discriminated union. The `kind` field is the tag — consumers narrow with
 *
 *   if (!result.ok) {
 *     switch (result.error.kind) {
 *       case "timeout":  // request budget exhausted
 *       case "abort":    // caller-initiated cancellation
 *       case "network":  // DNS, connection reset, TLS, etc.
 *     }
 *   }
 *
 * Following the canonical TypeScript pattern documented at
 * https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions
 * — a literal `kind` field lets the type checker narrow exhaustively without
 * relying on `instanceof` against multiple subclasses.
 */
/**
 * Tagged kinds for transport-layer failures. Listed in a `const` tuple so the
 * exhaustiveness check inside `LinkgrepNetworkError.from()` blocks a new kind
 * being added without a matching `classify()` branch.
 *
 * - `timeout` / `abort` — caller cancellation (terminal: retrying defeats intent).
 * - `oversize` — response body exceeded the cap (terminal: hostile/MITM
 *   origin will keep returning oversized payloads; retrying amplifies load).
 * - `network` — DNS / connection-reset / TLS / mid-stream transport failure
 *   (transient: safe to retry once or twice).
 */
const NETWORK_ERROR_KINDS = ["timeout", "abort", "oversize", "network"] as const;
export type LinkgrepNetworkErrorKind = (typeof NETWORK_ERROR_KINDS)[number];

/**
 * Terminal transport-failure predicate. Centralized so the three call sites
 * (retry.ts, the body-reader catch in client.ts, and classify() below)
 * share one definition — adding a terminal kind only needs editing this
 * function and the kind union.
 */
export function isTerminalTransportError(err: unknown): boolean {
  if (err instanceof LinkgrepNetworkError) {
    return err.kind === "timeout" || err.kind === "abort" || err.kind === "oversize";
  }
  if (err instanceof Error) {
    return err.name === "TimeoutError" || err.name === "AbortError";
  }
  return false;
}

export class LinkgrepNetworkError extends Error {
  readonly kind: LinkgrepNetworkErrorKind;
  override readonly cause?: unknown;
  constructor(kind: LinkgrepNetworkErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "LinkgrepNetworkError";
    this.kind = kind;
    this.cause = cause;
  }

  /**
   * Classify a thrown Error's `.name` into the tagged kind. Narrowed return
   * type triggers an exhaustiveness check (`never` assignment in the default
   * branch); adding a kind to `LinkgrepNetworkErrorKind` without a matching
   * `case` here is a compile error — the canonical TS discriminated-union
   * pattern from the handbook.
   * https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking
   */
  private static classify(name: string): LinkgrepNetworkErrorKind {
    switch (name) {
      case "TimeoutError":
        return "timeout";
      case "AbortError":
        return "abort";
      default:
        return "network";
    }
  }

  /** Classify a thrown error from fetch / body-read into a tagged transport failure. */
  static from(err: unknown): LinkgrepNetworkError {
    if (err instanceof Error) {
      return new LinkgrepNetworkError(LinkgrepNetworkError.classify(err.name), err.message, err);
    }
    return new LinkgrepNetworkError("network", String(err), err);
  }
}

// Compile-time exhaustiveness sentinel for LinkgrepNetworkErrorKind. If a
// future kind is added to the union without updating `classify()`'s switch,
// the `_exhaustive: never` assignment below fails to compile. Canonical
// pattern from the TypeScript handbook (Narrowing → Exhaustiveness checking).
{
  const _exhaustiveOnKind = (k: LinkgrepNetworkErrorKind): "timeout" | "abort" | "oversize" | "network" => {
    switch (k) {
      case "timeout":
        return "timeout";
      case "abort":
        return "abort";
      case "oversize":
        return "oversize";
      case "network":
        return "network";
      default: {
        const _never: never = k;
        return _never;
      }
    }
  };
  void _exhaustiveOnKind;
}

export function parseErrorResponse(res: Response, body: unknown): LinkgrepError {
  const ct = res.headers.get("content-type") ?? "";
  let code = "unknown";
  let message = res.statusText || "Request failed";
  let docUrl: string | undefined;

  // Primary: linkgrep envelope { error: { code, message, doc_url } }
  const envelope = (body as { error?: unknown } | null)?.error;
  if (envelope && typeof envelope === "object") {
    const e = envelope as Record<string, unknown>;
    if (typeof e.code === "string") code = e.code;
    if (typeof e.message === "string") message = e.message;
    if (typeof e.doc_url === "string") docUrl = e.doc_url;
  }
  // Fallback: RFC 9457 problem+json
  else if (ct.includes("application/problem+json") && body && typeof body === "object") {
    const p = body as Record<string, unknown>;
    if (typeof p.title === "string") {
      message = p.title;
    } else if (typeof p.detail === "string") {
      message = p.detail;
    }
    if (typeof p.type === "string" && p.type.startsWith("http")) {
      docUrl = p.type;
      // Use the type as a code hint if it ends with a recognisable token
      const last = p.type.split("/").pop() ?? "";
      if (last) code = last;
    }
  }
  // Unknown shape → keep defaults (code: "unknown", message: statusText). Raw preserved below.

  // Funnel: server-emitted codes outside the documented union land at
  // `"unknown"` so consumers writing exhaustive switches over
  // `LinkgrepErrorCode` get a single fallthrough branch ("unknown") rather
  // than an open `string` arm that defeats exhaustiveness. The raw envelope
  // is still preserved on `.raw` for introspection.
  const narrowedCode: LinkgrepErrorCode = KNOWN_ERROR_CODES.has(code as LinkgrepErrorCode)
    ? (code as LinkgrepErrorCode)
    : "unknown";

  const init: LinkgrepErrorInit = {
    status: res.status,
    code: narrowedCode,
    message,
    docUrl,
    requestId: res.headers.get("x-request-id") ?? undefined,
    raw: body,
    headers: res.headers,
  };

  switch (res.status) {
    case 400:
      return new BadRequestError(init);
    case 401:
      return new AuthenticationError(init);
    case 403:
      return new PermissionError(init);
    case 404:
      return new NotFoundError(init);
    case 409:
      return new ConflictError(init);
    case 410:
      return new GoneError(init);
    case 422:
      return new UnprocessableEntityError(init);
    case 429: {
      // RFC 9110 §10.2.3: Retry-After = HTTP-date / delay-seconds.
      // https://datatracker.ietf.org/doc/html/rfc9110#section-10.2.3
      return new RateLimitError({ ...init, retryAfter: parseRetryAfter(res.headers.get("retry-after")) });
    }
    case 500:
      return new InternalServerError(init);
    default:
      return new LinkgrepError(init);
  }
}

/**
 * Parse a Retry-After header value into a number of seconds from now.
 * Returns undefined for missing / malformed values.
 *
 * Accepts three shapes:
 *   1. `delay-seconds` (RFC 9110 §10.2.3) — `1*DIGIT`, non-negative base-10
 *      integer. Anchored on /^\d+$/ to reject negatives, decimals, hex
 *      literals (`0x10`), scientific notation (`1e3`), and whitespace-only
 *      strings (which `Number()` coerces to 0).
 *   2. HTTP-date (RFC 9110 §5.6.7) — IMF-fixdate / rfc850 / asctime, all of
 *      which contain literal whitespace between parts. Whitespace presence
 *      gates the Date.parse branch.
 *   3. ISO-8601 / RFC 3339 (e.g. `2026-12-31T00:00:00Z`) — emitted by
 *      strict modern servers. Detected via the leading `YYYY-MM-DD` anchor
 *      so V8's permissive `Date.parse("-5") → year 2001` foot-gun cannot
 *      slip through the bare-numeric branch.
 *
 * Refs:
 *   https://datatracker.ietf.org/doc/html/rfc9110#section-10.2.3
 *   https://datatracker.ietf.org/doc/html/rfc3339
 */
const ISO_DATE_ANCHOR = /^\d{4}-\d{2}-\d{2}[T\s]/;
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }
  // HTTP-date OR ISO-8601 path: either contains whitespace (IMF-fixdate /
  // rfc850 / asctime — RFC 9110 §5.6.7) or matches the ISO-8601 leading
  // `YYYY-MM-DD[T|space]` anchor. Both gate Date.parse() against V8's
  // over-permissive year-only interpretation of bare signed integers
  // (e.g. `Date.parse("-5")` → year 2001 epoch ms).
  if (!/\s/.test(trimmed) && !ISO_DATE_ANCHOR.test(trimmed)) return undefined;
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  return undefined;
}

/**
 * Result<T, E> — discriminated union used by `.safe()` variants.
 *
 * Pre-1.0 SDK convention: default methods throw `LinkgrepError`; opt-in `.safe()`
 * variants return `Result<T, E>` and never throw. Pattern matches Speakeasy
 * generated SDKs and Effect-TS Result.
 */
export type Result<T, E = LinkgrepError> =
  | { ok: true; data: T }
  | { ok: false; error: E };

/**
 * Map 409 Conflict into a `{ duplicate: true }` sentinel for endpoints whose
 * idempotency contract surfaces conflicts as a no-op marker rather than an
 * error. Centralized here so every track endpoint shares the same translation;
 * if the marker shape evolves, it changes in one place.
 *
 * Returns a true discriminated union `T | { duplicate: true }`. Track endpoint
 * response types must NOT include a `duplicate?: boolean` field — that would
 * defeat the discrimination and TS would let consumers read other fields on a
 * duplicate result as silently `undefined`. See track/lead.ts:TrackLeadResult
 * and types.ts comments for the contract.
 */
export function mapConflict<T>(
  p: Promise<T>,
): Promise<T | { duplicate: true }> {
  return p.catch((e: unknown) => {
    if (e instanceof ConflictError) return { duplicate: true } as const;
    throw e;
  });
}

/**
 * Lightweight runtime guard at the JSON-parse seam (keryx I-12). Narrows
 * `parsed: unknown` to `Record<string, unknown>` by rejecting array,
 * primitive, and null shapes — the SDK's track responses
 * (`TrackLeadResponse`, `TrackSaleResponse`) are documented as JSON
 * objects, so a non-object body is by definition a transport-layer
 * defect (upstream misconfiguration, MITM rewrite, edge-cache poisoning).
 *
 * What this guard catches:
 *   - Server returned a JSON array (`[...]`)
 *   - Server returned a JSON primitive (string / number / boolean / null)
 *   - Top-level shape mismatch with the documented envelope contract
 *
 * What this guard deliberately DOES NOT catch:
 *   - Wrong field types within a valid object (e.g. server returns
 *     `{ customerId: 12345 }` where the type declares `customerId: string`).
 *     The follow-on `parsed as TrackLeadResponse` / `parsed as TrackSaleResponse`
 *     cast in track/lead.ts and track/sale.ts is structurally unsound for
 *     this case — but the response types are all-optional and hand-maintained
 *     against the server schema (see types.ts:1-11 for the authoritative
 *     source). Per-field validation would require shipping a schema runtime
 *     (Zod, Valibot, custom validator) and would invalidate the manual-sync
 *     contract that lets consumers receive new server fields without an SDK
 *     bump. Consumers writing `response.customerId.toLowerCase()` on an
 *     unexpectedly-typed field will see a runtime TypeError; the SDK's
 *     guarantee is "transport-layer correctness," not "field-level type
 *     safety beyond the documented schema."
 *
 * Hand-rolled (no Zod) to preserve the SDK's small install footprint.
 */
export function assertResponseObject(parsed: unknown, endpoint: string): asserts parsed is Record<string, unknown> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LinkgrepNetworkError(
      "network",
      `${endpoint}: response body is not a JSON object (got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }
}

/**
 * Wrap a throwing async operation into a Result. Used by .safe() variants.
 * The error branch is a sealed discriminated union: either a `LinkgrepError`
 * (server returned a response with a recognized error envelope) or a
 * `LinkgrepNetworkError` (transport failure — DNS, abort, timeout). Consumers
 * narrow exhaustively via `instanceof LinkgrepError` or `error.kind`.
 *
 * Post-A1: HttpClient.post already wraps transport failures into
 * LinkgrepNetworkError at the seam, so errors reaching here are typed members
 * of the union. The defensive `.from()` fallback below catches any future code
 * path that throws an unwrapped error (e.g. a programming bug in mapConflict)
 * so the public Result contract still holds end-to-end.
 */
export async function toResult<T>(
  promise: Promise<T>,
): Promise<Result<T, LinkgrepError | LinkgrepNetworkError>> {
  try {
    return { ok: true, data: await promise };
  } catch (err) {
    if (err instanceof LinkgrepError || err instanceof LinkgrepNetworkError) {
      return { ok: false, error: err };
    }
    return { ok: false, error: LinkgrepNetworkError.from(err) };
  }
}
