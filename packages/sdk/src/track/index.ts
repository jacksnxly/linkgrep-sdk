import type { HttpClient } from "../http/client.js";
import { createLeadTracker } from "./lead.js";

export class TrackNamespace {
  readonly lead: ReturnType<typeof createLeadTracker>;

  constructor(http: HttpClient) {
    this.lead = createLeadTracker(http);
  }
}
