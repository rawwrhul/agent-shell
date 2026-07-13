// src/integrations/googleads/bid-changes.ts
//
// Deterministic layer for moving bidding targets (chunk 1d). Three shapes,
// discriminated on `field`:
//
//   target_cpa   - campaign tCPA. Strategy must be TARGET_CPA, or
//                  MAXIMIZE_CONVERSIONS with a target already set.
//   target_roas  - campaign tROAS. Strategy must be TARGET_ROAS, or
//                  MAXIMIZE_CONVERSION_VALUE with a target already set.
//   ad_group_cpc - ad group default CPC. MANUAL_CPC campaigns only.
//
// Direction reminder: raise tCPA = more aggressive; LOWER tROAS = more
// aggressive (inverse). Targetless Max Conversions / Max Conversion Value
// campaigns have no target to move - the executor refuses and points the
// agent at ads_change_budget instead.
//
// The 30% relative step cap is enforced at EXECUTION time against the live
// current value (the schema cannot know it). Larger moves take multiple
// approvals over days. Schema bounds below are absolute sanity rails only.

import { z } from 'zod'
import { ResourceNames, toMicros, resources, type MutateOperation } from 'google-ads-api'

export const MAX_RELATIVE_BID_STEP = 0.3
export const TARGET_CPA_MIN = 0.5
export const TARGET_CPA_MAX = 10000
export const TARGET_ROAS_MIN = 0.1
export const TARGET_ROAS_MAX = 100
export const AD_GROUP_CPC_MIN = 0.05
export const AD_GROUP_CPC_MAX = 200

export const BidChangeInputSchema = z.discriminatedUnion('field', [
  z.object({
    field:       z.literal('target_cpa'),
    campaign_id: z.coerce.number().int().positive(),
    new_target:  z.coerce.number()
      .min(TARGET_CPA_MIN, `target_cpa below ${TARGET_CPA_MIN}`)
      .max(TARGET_CPA_MAX, `target_cpa above ${TARGET_CPA_MAX}`),
    rationale:   z.string().max(500).optional(),
  }),
  z.object({
    field:       z.literal('target_roas'),
    campaign_id: z.coerce.number().int().positive(),
    new_target:  z.coerce.number()
      .min(TARGET_ROAS_MIN, `target_roas below ${TARGET_ROAS_MIN}`)
      .max(TARGET_ROAS_MAX, `target_roas above ${TARGET_ROAS_MAX}`),
    rationale:   z.string().max(500).optional(),
  }),
  z.object({
    field:       z.literal('ad_group_cpc'),
    campaign_id: z.coerce.number().int().positive(),
    ad_group_id: z.coerce.number().int().positive(),
    new_cpc:     z.coerce.number()
      .min(AD_GROUP_CPC_MIN, `cpc below ${AD_GROUP_CPC_MIN}`)
      .max(AD_GROUP_CPC_MAX, `cpc above ${AD_GROUP_CPC_MAX}`),
    rationale:   z.string().max(500).optional(),
  }),
])

export type BidChangeInput = z.infer<typeof BidChangeInputSchema>

/**
 * Relative step between the live current value and the proposed one.
 * Infinity when there is no usable baseline (caller decides what that means).
 */
export function relativeStep(current: number, next: number): number {
  if (!Number.isFinite(current) || current <= 0) return Number.POSITIVE_INFINITY
  return Math.abs(next - current) / current
}

/** Which campaign field actually holds the target, resolved from the live strategy type. */
export type CampaignTargetKind =
  | 'target_cpa'
  | 'maximize_conversions_with_tcpa'
  | 'target_roas'
  | 'maximize_conversion_value_with_troas'

export function buildCampaignTargetOp(
  customerId: string,
  campaignId: number,
  kind:       CampaignTargetKind,
  value:      number,
): MutateOperation<resources.ICampaign> {
  const resource_name = ResourceNames.campaign(customerId, campaignId)
  switch (kind) {
    case 'target_cpa':
      return { entity: 'campaign', operation: 'update', resource: { resource_name, target_cpa: { target_cpa_micros: toMicros(value) } } }
    case 'maximize_conversions_with_tcpa':
      return { entity: 'campaign', operation: 'update', resource: { resource_name, maximize_conversions: { target_cpa_micros: toMicros(value) } } }
    case 'target_roas':
      return { entity: 'campaign', operation: 'update', resource: { resource_name, target_roas: { target_roas: value } } }
    case 'maximize_conversion_value_with_troas':
      return { entity: 'campaign', operation: 'update', resource: { resource_name, maximize_conversion_value: { target_roas: value } } }
  }
}

export function buildAdGroupCpcOp(
  customerId: string,
  adGroupId:  number,
  cpc:        number,
): MutateOperation<resources.IAdGroup> {
  return {
    entity:    'ad_group',
    operation: 'update',
    resource:  {
      resource_name:  ResourceNames.adGroup(customerId, adGroupId),
      cpc_bid_micros: toMicros(cpc),
    },
  }
}
