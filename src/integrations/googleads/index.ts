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
export {
  execAdsChangeBids, execAdsChangeBudget, execAdsAddKeywords,
  execAdsCreateAdGroup, execAdsCreateCampaign, execAdsUpdateAdCopy,
} from './executor'
export { BidChangeInputSchema, relativeStep, buildCampaignTargetOp, buildAdGroupCpcOp, MAX_RELATIVE_BID_STEP } from './bid-changes'
export type { BidChangeInput, CampaignTargetKind } from './bid-changes'
export { BudgetChangeInputSchema, diagnoseBudgetIncrease, buildBudgetUpdateOp, MAX_RELATIVE_BUDGET_STEP, BUDGET_LOST_IS_FLOOR } from './budget-changes'
export type { BudgetChangeInput, BudgetIncreaseDiagnosis } from './budget-changes'
export {
  AddKeywordsInputSchema, buildAddKeywordOps,
  CreateAdGroupInputSchema, buildCreateAdGroupOps,
  CreateCampaignInputSchema, buildCreateCampaignOps,
} from './expansion'
export type { AddKeywordsInput, CreateAdGroupInput, CreateCampaignInput } from './expansion'
export { AdCopyInputSchema, buildCreateRsaOp, buildPauseAdOp } from './ad-copy'
export type { AdCopyInput } from './ad-copy'
export { forTenant, listAccessibleCustomers, TenantAdsClient } from './client'
export { resolveSharedCreds, resolveTenantConfig } from './auth'
export { withBackoff, isRetryable } from './retry'
export { InMemoryQuotaGuard, QuotaExceededError, DEFAULT_DAILY_OPERATION_CEILING } from './quota'
export { normalizeCid, SHARED_CRED_KEYS, TENANT_CUSTOMER_ID_KEY } from './types'
export type { SharedGoogleAdsCreds, TenantGoogleAdsConfig } from './types'

// Micros conversion for the chunk 1b+ deterministic bid/budget math.
export { fromMicros, toMicros } from 'google-ads-api'
