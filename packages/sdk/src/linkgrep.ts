import { HttpClient, type HttpClientOptions } from "./http/client.js";
import { TrackNamespace } from "./track/index.js";

export interface LinkgrepOptions extends HttpClientOptions {}

export class Linkgrep {
  readonly track: TrackNamespace;

  constructor(opts: LinkgrepOptions) {
    const http = new HttpClient(opts);
    this.track = new TrackNamespace(http);
  }
}
