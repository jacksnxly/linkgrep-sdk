import { HttpClient, type Fetcher } from "./http/client.js";
import type { RetryOptions } from "./http/retry.js";
import { TrackNamespace } from "./track/index.js";

/**
 * Public SDK options. Enumerated explicitly (rather than `extends
 * HttpClientOptions`) so internal HttpClient fields cannot auto-leak into
 * the documented surface as the implementation evolves. Every field here
 * is part of the v0.x contract; new internal HttpClient options remain
 * internal unless deliberately surfaced here.
 */
export interface LinkgrepOptions {
  /** Linkgrep API bearer token. */
  token: string;
  /** Override the API host. Default: https://api.linkgrep.xyz */
  baseUrl?: string;
  /** Per-attempt timeout in milliseconds. Default: 10_000. */
  timeoutMs?: number;
  /** Retry policy. See `RetryOptions`. */
  retry?: RetryOptions;
  /** Caller-supplied AbortSignal for cancellation mid-call / mid-retry. */
  signal?: AbortSignal;
  /** Pluggable fetch transport (Cloudflare Workers binding, undici Agent, test stub). */
  fetch?: Fetcher;
}

export class Linkgrep {
  readonly track: TrackNamespace;

  constructor(opts: LinkgrepOptions) {
    const http = new HttpClient(opts);
    this.track = new TrackNamespace(http);
  }
}
