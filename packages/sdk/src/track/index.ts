import type { HttpClient } from "../http/client.js";
import { createLeadTracker, type LeadTracker } from "./lead.js";
import { createSaleTracker, type SaleTracker } from "./sale.js";

export class TrackNamespace {
  readonly lead: LeadTracker;
  readonly sale: SaleTracker;

  constructor(http: HttpClient) {
    this.lead = createLeadTracker(http);
    this.sale = createSaleTracker(http);
  }
}
