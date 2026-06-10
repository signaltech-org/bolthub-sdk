import type { z } from "zod";
import type {
  tenantSchema,
  originSchema,
  endpointSchema,
  endpointParameterSchema,
  pricingRuleSchema,
  invoiceSchema,
  billingCycleSchema,
  sessionSchema,
  createTenantSchema,
  createOriginSchema,
  createEndpointSchema,
  createPricingRuleSchema,
} from "./schemas";

export type TenantStatus = "onboarding" | "active" | "suspended" | "deleted";
export type PricingModel = "per_request" | "per_kb" | "token_bucket" | "time_pass" | "metered";
export type InvoiceStatus = "pending" | "settled" | "consumed" | "expired" | "cancelled";
export type BillingCycleStatus = "accumulating" | "invoiced" | "paid" | "failed";
export type BillingStatus = "active" | "trial" | "grace_period" | "suspended";
export type SessionStatus = "active" | "expired" | "depleted";

export type Tenant = z.infer<typeof tenantSchema>;
export type Origin = z.infer<typeof originSchema>;
export type EndpointParameter = z.infer<typeof endpointParameterSchema>;
export type Endpoint = z.infer<typeof endpointSchema>;
export type PricingRule = z.infer<typeof pricingRuleSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export type BillingCycle = z.infer<typeof billingCycleSchema>;
export type Session = z.infer<typeof sessionSchema>;

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type CreateOriginInput = z.infer<typeof createOriginSchema>;
export type CreateEndpointInput = z.infer<typeof createEndpointSchema>;
export type CreatePricingRuleInput = z.infer<typeof createPricingRuleSchema>;
