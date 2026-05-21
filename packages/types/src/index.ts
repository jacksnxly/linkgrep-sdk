import { z } from "zod";

// ---------- Public SDK input (flat, ergonomic) ----------
export const TrackLeadInputSchema = z.object({
  clickId: z.string().optional(),
  eventName: z.string().min(1).max(255),
  customerExternalId: z.string().min(1).max(100),
  customerName: z.string().optional(),
  customerEmail: z.string().email().optional(),
  mode: z.enum(["wait", "fire-and-forget", "deferred"]).default("fire-and-forget"),
  metadata: z.record(z.unknown()).optional(),
});
export type TrackLeadInput = z.infer<typeof TrackLeadInputSchema>;

// ---------- HTTP wire shape (matches linkgrep server schema) ----------
// See: linkgrep/apps/web/app/api/track/schemas.ts -> trackLeadSchema
export const TrackLeadWireSchema = z.object({
  clickId: z.string().optional(),
  eventName: z.string(),
  customer: z.object({
    externalId: z.string().optional(),
    email: z.string().email().optional(),
    name: z.string().optional(),
  }),
  mode: z.enum(["wait", "fire-and-forget", "deferred"]),
  metadata: z.record(z.unknown()).optional(),
});
export type TrackLeadWire = z.infer<typeof TrackLeadWireSchema>;

// ---------- Lead response (server may include attribution chain) ----------
export const TrackLeadResponseSchema = z.object({
  customerId: z.string().optional(),
  clickId: z.string().optional(),
  partnerId: z.string().optional(),
  programId: z.string().optional(),
  commissionId: z.string().optional(),
  commissionAmount: z.number().optional(),
  // NOTE: synthesized client-side on HTTP 409 — the server returns no body.
  duplicate: z.boolean().optional(),
});
export type TrackLeadResponse = z.infer<typeof TrackLeadResponseSchema>;

// ---------- Sale input (flat; matches server wire shape directly) ----------
// See: linkgrep/apps/web/app/api/track/schemas.ts -> trackSaleSchema
// `paymentProcessor` and `eventName` are NOT accepted by the server — do not add.
export const TrackSaleInputSchema = z
  .object({
    clickId: z.string().optional(),
    customerExternalId: z.string().min(1).max(100).optional(),
    amount: z.number().positive(),
    currency: z.string().length(3).default("usd"),
    invoiceId: z.string().optional(),
    leadEventName: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .refine((d) => d.clickId || d.customerExternalId, {
    message: "Either clickId or customerExternalId is required",
    path: ["clickId"],
  });
export type TrackSaleInput = z.infer<typeof TrackSaleInputSchema>;

export const TrackSaleResponseSchema = z.object({
  commissionId: z.string().optional(),
  commissionAmount: z.number().optional(),
  status: z.string().optional(),
  // NOTE: synthesized client-side on HTTP 409 — the server returns no body.
  duplicate: z.boolean().optional(),
});
export type TrackSaleResponse = z.infer<typeof TrackSaleResponseSchema>;
