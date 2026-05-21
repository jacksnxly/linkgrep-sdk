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
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
      return new RateLimitError({
        ...init,
        retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
      });
    }
    case 500:
      return new InternalServerError(init);
    default:
      return new LinkgrepError(init);
  }
}
