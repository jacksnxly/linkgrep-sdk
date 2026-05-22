export interface LinkgrepErrorInit {
  status: number;
  code: string;
  message: string;
  docUrl?: string;
  requestId?: string;
  raw: unknown;
  headers: Headers;
}

export class LinkgrepError extends Error {
  readonly status: number;
  readonly code: string;
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

  const init: LinkgrepErrorInit = {
    status: res.status,
    code,
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
 * Parse a Retry-After header value (delta-seconds OR HTTP-date) into a number
 * of seconds from now. Returns undefined for missing / malformed values.
 *
 * Per RFC 9110 §10.2.3: `delay-seconds = 1*DIGIT` — non-negative base-10
 * integer. We anchor the seconds branch on /^\d+$/ instead of Number() to
 * reject negatives, decimals, hex literals (`0x10`), scientific notation
 * (`1e3`), and whitespace-only strings (which `Number()` coerces to 0).
 * https://datatracker.ietf.org/doc/html/rfc9110#section-10.2.3
 */
function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isSafeInteger(n)) return n;
  }
  // HTTP-date per RFC 9110 §5.6.7 always contains whitespace between parts
  // (e.g. "Sun, 06 Nov 1994 08:49:37 GMT"). Requiring whitespace here rejects
  // numeric-looking strings ("-5", "+12") that V8's Date.parse permissively
  // interprets as years (e.g. Date.parse("-5") → year 2001 epoch ms).
  if (!/\s/.test(trimmed)) return undefined;
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
 * The return is widened to `T | { duplicate: true }` instead of cast back to
 * `T`. Previously `{ duplicate: true } as T` would silently produce an
 * incomplete object if a future response type added required fields — the
 * unsafe cast hid the violation. The discriminated union forces callers to
 * narrow via `result.duplicate` before reading other fields.
 */
export function mapConflict<T extends { duplicate?: boolean }>(
  p: Promise<T>,
): Promise<T | { duplicate: true }> {
  return p.catch((e: unknown) => {
    if (e instanceof ConflictError) return { duplicate: true } as const;
    throw e;
  });
}

/**
 * Wrap a throwing async operation into a Result. Used by .safe() variants.
 * LinkgrepError is preserved on `result.error`; raw network `Error`s (fetch
 * failures, DNS errors, aborts) are also returned as-is. The error type is
 * `LinkgrepError | Error` because network errors are NOT LinkgrepError —
 * they originate before any server response can be parsed.
 */
export async function toResult<T>(
  promise: Promise<T>,
): Promise<Result<T, LinkgrepError | Error>> {
  try {
    return { ok: true, data: await promise };
  } catch (err) {
    if (err instanceof Error) {
      return { ok: false, error: err };
    }
    return { ok: false, error: new Error(String(err)) };
  }
}
