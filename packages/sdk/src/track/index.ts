import type { HttpClient } from "../http/client.js";
import { createLeadTracker } from "./lead.js";
import { createSaleTracker } from "./sale.js";

export class TrackNamespace {
  readonly lead: ReturnType<typeof createLeadTracker>;
  readonly sale: ReturnType<typeof createSaleTracker>;

  constructor(http: HttpClient) {
    this.lead = createLeadTracker(http);
    this.sale = createSaleTracker(http);
  }
}
