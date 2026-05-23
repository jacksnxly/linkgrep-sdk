export { formatTrackError } from "./format.js";
export type { Fetcher } from "./http/client.js";
export type { LinkgrepErrorCode, LinkgrepNetworkErrorKind, Result } from "./http/errors.js";
export {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  GoneError,
  InternalServerError,
  LinkgrepError,
  LinkgrepNetworkError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  UnprocessableEntityError,
} from "./http/errors.js";
export type { RetryOptions } from "./http/retry.js";
export type { LinkgrepOptions } from "./linkgrep.js";
export { Linkgrep } from "./linkgrep.js";
export { CLICK_ID_PATTERN, DEFAULT_CLICK_ID_COOKIE } from "./protocol.js";
export type { LeadTracker, TrackLeadResult } from "./track/lead.js";
export type { SaleTracker, TrackSaleResult } from "./track/sale.js";
export type {
  TrackLeadInput,
  TrackLeadResponse,
  TrackSaleInput,
  TrackSaleResponse,
} from "./types.js";
