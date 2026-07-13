// src/integrations/googleads/expansion.ts
//
// Deterministic layer for the expansion actions (chunk 1e):
//
//   ads_add_keywords     - positive keywords onto an EXISTING ad group
//                          (expansion on proven performers).
//   ads_create_ad_group  - new ad group in an existing campaign. Created
//                          PAUSED - enabling is the operator's action in
//                          the Google Ads UI, never the agent's.
//   ads_create_campaign  - new SEARCH campaign. Created PAUSED, AU geo +
//                          English targeting, own (non-shared) budget.
//
// Creation ops use negative temp ids so the ad group / campaign and its
// children land atomically in a single mutate request.

import { z } from 'zod'
import { ResourceNames, enums, toMicros, resources, type MutateOperation } from 'google-ads-api'

export const MAX_ADD_KEYWORDS_PER_PROPOSAL = 30
export const MAX_SEED_KEYWORDS_PER_AD_GROUP = 30
export const KEYWORD_CPC_MIN = 0.05
export const KEYWORD_CPC_MAX = 200
export const NEW_CAMPAIGN_BUDGET_MIN = 1
export const NEW_CAMPAIGN_BUDGET_MAX = 1000
export const NEW_CAMPAIGN_TARGET_CPA_MIN = 0.5
export const NEW_CAMPAIGN_TARGET_CPA_MAX = 10000

/** Australia geo target constant; English language constant. */
export const GEO_TARGET_AU = 2036
export const LANGUAGE_EN = 1000

const MAX_KEYWORD_CHARS = 80
const MAX_KEYWORD_WORDS = 10
const MAX_NAME_CHARS = 128

const MatchType = z.enum(['EXACT', 'PHRASE', 'BROAD'])

const KeywordSchema = z.object({
  text: z.string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string()
      .min(1, 'keyword text is empty')
      .max(MAX_KEYWORD_CHARS, `keyword exceeds ${MAX_KEYWORD_CHARS} characters`)
      .refine((s) => s.split(' ').length <= MAX_KEYWORD_WORDS, `keyword exceeds ${MAX_KEYWORD_WORDS} words`)
      .refine((s) => !/[<>{}\\|~^%!@*;=\[\]]/.test(s), 'keyword contains characters Google Ads rejects')),
  match_type: MatchType,
  cpc: z.coerce.number()
    .min(KEYWORD_CPC_MIN, `cpc below ${KEYWORD_CPC_MIN}`)
    .max(KEYWORD_CPC_MAX, `cpc above ${KEYWORD_CPC_MAX}`)
    .optional(),
})

const NameSchema = z.string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'name is empty').max(MAX_NAME_CHARS, `name exceeds ${MAX_NAME_CHARS} characters`))

function dedupePositiveKeywords<K extends { text: string; match_type: string }>(keywords: K[]): K[] {
  const seen = new Set<string>()
  const out: K[] = []
  for (const k of keywords) {
    const key = `${k.match_type}:${k.text.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(k)
  }
  return out
}

// ── ads_add_keywords ────────────────────────────────────────────────────

export const AddKeywordsInputSchema = z.object({
  campaign_id: z.coerce.number().int().positive(),
  ad_group_id: z.coerce.number().int().positive(),
  keywords:    z.array(KeywordSchema)
    .min(1, 'at least one keyword required')
    .max(MAX_ADD_KEYWORDS_PER_PROPOSAL, `max ${MAX_ADD_KEYWORDS_PER_PROPOSAL} keywords per proposal`),
  rationale:   z.string().max(500).optional(),
})

export type AddKeywordsInput = z.infer<typeof AddKeywordsInputSchema>

const MATCH_ENUM: Record<z.infer<typeof MatchType>, enums.KeywordMatchType> = {
  EXACT:  enums.KeywordMatchType.EXACT,
  PHRASE: enums.KeywordMatchType.PHRASE,
  BROAD:  enums.KeywordMatchType.BROAD,
}

export function buildAddKeywordOps(
  customerId: string,
  input:      AddKeywordsInput,
  keywords:   AddKeywordsInput['keywords'] = input.keywords,
): MutateOperation<resources.IAdGroupCriterion>[] {
  const ad_group = ResourceNames.adGroup(customerId, input.ad_group_id)
  return dedupePositiveKeywords(keywords).map((k) => ({
    entity:    'ad_group_criterion',
    operation: 'create',
    resource: {
      ad_group,
      status:   enums.AdGroupCriterionStatus.ENABLED,
      keyword:  { text: k.text, match_type: MATCH_ENUM[k.match_type] },
      ...(k.cpc != null ? { cpc_bid_micros: toMicros(k.cpc) } : {}),
    },
  }))
}

export { dedupePositiveKeywords }

// ── ads_create_ad_group ─────────────────────────────────────────────────

export const CreateAdGroupInputSchema = z.object({
  campaign_id: z.coerce.number().int().positive(),
  name:        NameSchema,
  keywords:    z.array(KeywordSchema)
    .max(MAX_SEED_KEYWORDS_PER_AD_GROUP, `max ${MAX_SEED_KEYWORDS_PER_AD_GROUP} seed keywords`)
    .optional(),
  default_cpc: z.coerce.number()
    .min(KEYWORD_CPC_MIN, `default_cpc below ${KEYWORD_CPC_MIN}`)
    .max(KEYWORD_CPC_MAX, `default_cpc above ${KEYWORD_CPC_MAX}`)
    .optional(),
  rationale:   z.string().max(500).optional(),
})

export type CreateAdGroupInput = z.infer<typeof CreateAdGroupInputSchema>

/**
 * Atomic create: ad group (temp id -1, PAUSED) plus its seed keywords in
 * one mutate request. Nothing goes live until the operator enables the ad
 * group in the Google Ads UI.
 */
export function buildCreateAdGroupOps(
  customerId: string,
  input:      CreateAdGroupInput,
): MutateOperation<Record<string, unknown>>[] {
  const tempAdGroup = ResourceNames.adGroup(customerId, -1)
  const ops: MutateOperation<Record<string, unknown>>[] = [{
    entity:    'ad_group',
    operation: 'create',
    resource: {
      resource_name: tempAdGroup,
      campaign:      ResourceNames.campaign(customerId, input.campaign_id),
      name:          input.name,
      status:        enums.AdGroupStatus.PAUSED,
      type:          enums.AdGroupType.SEARCH_STANDARD,
      ...(input.default_cpc != null ? { cpc_bid_micros: toMicros(input.default_cpc) } : {}),
    },
  }]
  for (const k of dedupePositiveKeywords(input.keywords ?? [])) {
    ops.push({
      entity:    'ad_group_criterion',
      operation: 'create',
      resource: {
        ad_group: tempAdGroup,
        status:   enums.AdGroupCriterionStatus.ENABLED,
        keyword:  { text: k.text, match_type: MATCH_ENUM[k.match_type] },
        ...(k.cpc != null ? { cpc_bid_micros: toMicros(k.cpc) } : {}),
      },
    })
  }
  return ops
}

// ── ads_create_campaign ─────────────────────────────────────────────────

export const CreateCampaignInputSchema = z.object({
  name:         NameSchema,
  daily_budget: z.coerce.number()
    .min(NEW_CAMPAIGN_BUDGET_MIN, `daily_budget below ${NEW_CAMPAIGN_BUDGET_MIN}`)
    .max(NEW_CAMPAIGN_BUDGET_MAX, `daily_budget above ${NEW_CAMPAIGN_BUDGET_MAX} - new campaigns start small`),
  bidding: z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('MANUAL_CPC') }),
    z.object({
      strategy:   z.literal('MAXIMIZE_CONVERSIONS'),
      target_cpa: z.coerce.number()
        .min(NEW_CAMPAIGN_TARGET_CPA_MIN, `target_cpa below ${NEW_CAMPAIGN_TARGET_CPA_MIN}`)
        .max(NEW_CAMPAIGN_TARGET_CPA_MAX, `target_cpa above ${NEW_CAMPAIGN_TARGET_CPA_MAX}`)
        .optional(),
    }),
  ]),
  rationale:    z.string().max(500).optional(),
})

export type CreateCampaignInput = z.infer<typeof CreateCampaignInputSchema>

/**
 * Atomic create: dedicated (non-shared) budget, PAUSED search campaign,
 * AU geo + English targeting - four ops, one mutate request. Search
 * partners and display expansion are off; the operator enables the
 * campaign in the UI after review.
 */
export function buildCreateCampaignOps(
  customerId: string,
  input:      CreateCampaignInput,
): MutateOperation<Record<string, unknown>>[] {
  const tempBudget   = ResourceNames.campaignBudget(customerId, -1)
  const tempCampaign = ResourceNames.campaign(customerId, -2)

  const bidding: Record<string, unknown> = input.bidding.strategy === 'MANUAL_CPC'
    ? { manual_cpc: {} }
    : {
        maximize_conversions: input.bidding.target_cpa != null
          ? { target_cpa_micros: toMicros(input.bidding.target_cpa) }
          : {},
      }

  return [
    {
      entity:    'campaign_budget',
      operation: 'create',
      resource: {
        resource_name:      tempBudget,
        name:               `${input.name} - budget`,
        amount_micros:      toMicros(input.daily_budget),
        delivery_method:    enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared:  false,
      },
    },
    {
      entity:    'campaign',
      operation: 'create',
      resource: {
        resource_name:            tempCampaign,
        name:                     input.name,
        status:                   enums.CampaignStatus.PAUSED,
        advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
        campaign_budget:          tempBudget,
        ...bidding,
        network_settings: {
          target_google_search:           true,
          target_search_network:          false,
          target_content_network:         false,
          target_partner_search_network:  false,
        },
      },
    },
    {
      entity:    'campaign_criterion',
      operation: 'create',
      resource: {
        campaign: tempCampaign,
        location: { geo_target_constant: ResourceNames.geoTargetConstant(GEO_TARGET_AU) },
      },
    },
    {
      entity:    'campaign_criterion',
      operation: 'create',
      resource: {
        campaign: tempCampaign,
        language: { language_constant: ResourceNames.languageConstant(LANGUAGE_EN) },
      },
    },
  ]
}
