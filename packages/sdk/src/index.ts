export { Linkgrep } from "./linkgrep.js";
export type { LinkgrepOptions } from "./linkgrep.js";
export {
  LinkgrepError,
  BadRequestError,
  AuthenticationError,
  PermissionError,
  NotFoundError,
  ConflictError,
  GoneError,
  UnprocessableEntityError,
  RateLimitError,
  InternalServerError,
} from "./http/errors.js";
export type { Result } from "./http/errors.js";
export type { LeadTracker } from "./track/lead.js";
export type { SaleTracker } from "./track/sale.js";
export type {
  TrackLeadInput,
  TrackLeadResponse,
  TrackSaleInput,
  TrackSaleResponse,
} from "@linkgrep/types";
