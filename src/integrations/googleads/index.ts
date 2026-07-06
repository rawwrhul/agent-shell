// src/integrations/googleads/index.ts

export { GOOGLE_ADS_TOOLS, isGoogleAdsToolName, executeGoogleAdsTool } from './tools'
export { forTenant, listAccessibleCustomers, TenantAdsClient } from './client'
export { resolveSharedCreds, resolveTenantConfig } from './auth'
export { withBackoff, isRetryable } from './retry'
export { InMemoryQuotaGuard, QuotaExceededError, DEFAULT_DAILY_OPERATION_CEILING } from './quota'
export { normalizeCid, SHARED_CRED_KEYS, TENANT_CUSTOMER_ID_KEY } from './types'
export type { SharedGoogleAdsCreds, TenantGoogleAdsConfig } from './types'

// Micros conversion for the chunk 1b+ deterministic bid/budget math.
export { fromMicros, toMicros } from 'google-ads-api'
