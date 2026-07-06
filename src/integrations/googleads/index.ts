// src/integrations/googleads/index.ts

export { GOOGLE_ADS_TOOLS, isGoogleAdsToolName, executeGoogleAdsTool } from './tools'
export { execAdsAddNegativeKeywords } from './executor'
export { NegativeKeywordsInputSchema, dedupeKeywords, buildCampaignNegativeOps, buildAdGroupNegativeOps, MAX_NEGATIVES_PER_PROPOSAL } from './negatives'
export type { NegativeKeywordsInput } from './negatives'
export { execAdsSetBidModifiers, execAdsEditKeywords } from './executor'
export { BidModifiersInputSchema, buildBidModifierOps, MODIFIER_MIN, MODIFIER_MAX } from './bid-modifiers'
export type { BidModifiersInput, ExistingModifiers } from './bid-modifiers'
export { KeywordEditsInputSchema, buildKeywordEditOps, CPC_MIN, CPC_MAX } from './keyword-edits'
export type { KeywordEditsInput } from './keyword-edits'
export { forTenant, listAccessibleCustomers, TenantAdsClient } from './client'
export { resolveSharedCreds, resolveTenantConfig } from './auth'
export { withBackoff, isRetryable } from './retry'
export { InMemoryQuotaGuard, QuotaExceededError, DEFAULT_DAILY_OPERATION_CEILING } from './quota'
export { normalizeCid, SHARED_CRED_KEYS, TENANT_CUSTOMER_ID_KEY } from './types'
export type { SharedGoogleAdsCreds, TenantGoogleAdsConfig } from './types'

// Micros conversion for the chunk 1b+ deterministic bid/budget math.
export { fromMicros, toMicros } from 'google-ads-api'
