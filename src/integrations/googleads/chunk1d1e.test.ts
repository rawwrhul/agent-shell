// src/integrations/googleads/chunk1d1e.test.ts
//
// Deterministic-layer tests for chunks 1d (bids, budget) and 1e (expansion,
// ad copy). Everything here is pure: schemas, step math, diagnosis, op
// construction. The executors' live pre-reads are exercised against real
// accounts, not mocked here.

import { describe, it, expect } from 'vitest'
import { toMicros } from 'google-ads-api'
import {
  BidChangeInputSchema, relativeStep, buildCampaignTargetOp, buildAdGroupCpcOp,
  MAX_RELATIVE_BID_STEP,
} from './bid-changes'
import {
  BudgetChangeInputSchema, diagnoseBudgetIncrease, buildBudgetUpdateOp,
  BUDGET_LOST_IS_FLOOR,
} from './budget-changes'
import {
  AddKeywordsInputSchema, buildAddKeywordOps,
  CreateAdGroupInputSchema, buildCreateAdGroupOps,
  CreateCampaignInputSchema, buildCreateCampaignOps,
} from './expansion'
import { AdCopyInputSchema, buildCreateRsaOp, buildPauseAdOp } from './ad-copy'

const CID = '1234567890'

describe('relativeStep', () => {
  it('computes symmetric relative steps', () => {
    expect(relativeStep(100, 130)).toBeCloseTo(0.3)
    expect(relativeStep(100, 70)).toBeCloseTo(0.3)
  })

  it('returns Infinity with no usable baseline', () => {
    expect(relativeStep(0, 50)).toBe(Number.POSITIVE_INFINITY)
    expect(relativeStep(NaN, 50)).toBe(Number.POSITIVE_INFINITY)
  })

  it('the 30% cap boundary is inclusive', () => {
    expect(relativeStep(100, 130) <= MAX_RELATIVE_BID_STEP).toBe(true)
    expect(relativeStep(100, 131) <= MAX_RELATIVE_BID_STEP).toBe(false)
  })
})

describe('BidChangeInputSchema', () => {
  it('accepts each of the three shapes', () => {
    expect(BidChangeInputSchema.safeParse({ field: 'target_cpa', campaign_id: 1, new_target: 45 }).success).toBe(true)
    expect(BidChangeInputSchema.safeParse({ field: 'target_roas', campaign_id: 1, new_target: 4.5 }).success).toBe(true)
    expect(BidChangeInputSchema.safeParse({ field: 'ad_group_cpc', campaign_id: 1, ad_group_id: 2, new_cpc: 1.8 }).success).toBe(true)
  })

  it('rejects out-of-bounds targets and a cpc shape without ad_group_id', () => {
    expect(BidChangeInputSchema.safeParse({ field: 'target_cpa', campaign_id: 1, new_target: 50000 }).success).toBe(false)
    expect(BidChangeInputSchema.safeParse({ field: 'target_roas', campaign_id: 1, new_target: 101 }).success).toBe(false)
    expect(BidChangeInputSchema.safeParse({ field: 'ad_group_cpc', campaign_id: 1, new_cpc: 1.8 }).success).toBe(false)
  })
})

describe('buildCampaignTargetOp / buildAdGroupCpcOp', () => {
  it('tCPA goes out in micros on the right strategy field', () => {
    const std = buildCampaignTargetOp(CID, 7, 'target_cpa', 42)
    expect(std.resource.target_cpa?.target_cpa_micros).toBe(toMicros(42))
    const mc = buildCampaignTargetOp(CID, 7, 'maximize_conversions_with_tcpa', 42)
    expect(mc.resource.maximize_conversions?.target_cpa_micros).toBe(toMicros(42))
  })

  it('tROAS goes out as a ratio, not micros', () => {
    const op = buildCampaignTargetOp(CID, 7, 'target_roas', 3.5)
    expect(op.resource.target_roas?.target_roas).toBe(3.5)
  })

  it('ad group CPC updates cpc_bid_micros on the ad group', () => {
    const op = buildAdGroupCpcOp(CID, 9, 2.4)
    expect(op.entity).toBe('ad_group')
    expect(op.operation).toBe('update')
    expect(op.resource.cpc_bid_micros).toBe(toMicros(2.4))
  })
})

describe('diagnoseBudgetIncrease', () => {
  it('refuses rank-dominant loss', () => {
    expect(diagnoseBudgetIncrease(0.1, 0.3)).toBe('rank_dominant')
  })

  it('refuses when nothing is budget-constrained', () => {
    expect(diagnoseBudgetIncrease(0.02, 0.01)).toBe('no_lost_is')
  })

  it('accepts budget-dominant loss at or above the floor', () => {
    expect(diagnoseBudgetIncrease(BUDGET_LOST_IS_FLOOR, 0.01)).toBe('increase_ok')
    expect(diagnoseBudgetIncrease(0.4, 0.1)).toBe('increase_ok')
  })
})

describe('BudgetChangeInputSchema / buildBudgetUpdateOp', () => {
  it('bounds the daily budget', () => {
    expect(BudgetChangeInputSchema.safeParse({ campaign_id: 1, new_daily_budget: 0.5 }).success).toBe(false)
    expect(BudgetChangeInputSchema.safeParse({ campaign_id: 1, new_daily_budget: 50000 }).success).toBe(false)
    expect(BudgetChangeInputSchema.safeParse({ campaign_id: 1, new_daily_budget: 150 }).success).toBe(true)
  })

  it('update op carries micros to the budget resource', () => {
    const op = buildBudgetUpdateOp(`customers/${CID}/campaignBudgets/55`, 120)
    expect(op.entity).toBe('campaign_budget')
    expect(op.resource.amount_micros).toBe(toMicros(120))
  })
})

describe('expansion: add keywords', () => {
  it('dedupes case-insensitively and carries optional cpc as micros', () => {
    const input = AddKeywordsInputSchema.parse({
      campaign_id: 1, ad_group_id: 2,
      keywords: [
        { text: 'emergency electrician', match_type: 'PHRASE', cpc: 3.5 },
        { text: 'Emergency Electrician', match_type: 'PHRASE' },
        { text: 'level 2 electrician', match_type: 'EXACT' },
      ],
    })
    const ops = buildAddKeywordOps(CID, input)
    expect(ops).toHaveLength(2)
    expect(ops[0].resource.cpc_bid_micros).toBe(toMicros(3.5))
    expect(ops[1].resource.cpc_bid_micros).toBeUndefined()
  })

  it('caps at 30 keywords per proposal', () => {
    const keywords = Array.from({ length: 31 }, (_, i) => ({ text: `kw ${i}`, match_type: 'BROAD' }))
    expect(AddKeywordsInputSchema.safeParse({ campaign_id: 1, ad_group_id: 2, keywords }).success).toBe(false)
  })
})

describe('expansion: create ad group', () => {
  it('creates PAUSED with seed keywords bound to the temp resource', () => {
    const input = CreateAdGroupInputSchema.parse({
      campaign_id: 3, name: 'Switchboard Upgrades', default_cpc: 4,
      keywords: [{ text: 'switchboard upgrade sydney', match_type: 'PHRASE' }],
    })
    const ops = buildCreateAdGroupOps(CID, input)
    expect(ops).toHaveLength(2)
    const [group, kw] = ops
    expect(group.entity).toBe('ad_group')
    expect(String(group.resource.resource_name)).toContain('/adGroups/-1')
    expect(kw.resource.ad_group).toBe(group.resource.resource_name)
    expect(group.resource.cpc_bid_micros).toBe(toMicros(4))
  })
})

describe('expansion: create campaign', () => {
  it('builds budget + paused search campaign + AU geo + English atomically', () => {
    const input = CreateCampaignInputSchema.parse({
      name: 'Emergency - Sydney', daily_budget: 80,
      bidding: { strategy: 'MAXIMIZE_CONVERSIONS', target_cpa: 60 },
    })
    const ops = buildCreateCampaignOps(CID, input)
    expect(ops).toHaveLength(4)
    const [budget, campaign, geo, lang] = ops
    expect(budget.resource.explicitly_shared).toBe(false)
    expect(budget.resource.amount_micros).toBe(toMicros(80))
    expect(campaign.resource.campaign_budget).toBe(budget.resource.resource_name)
    expect((campaign.resource.maximize_conversions as { target_cpa_micros: number }).target_cpa_micros).toBe(toMicros(60))
    expect((geo.resource.location as { geo_target_constant: string }).geo_target_constant).toBe('geoTargetConstants/2036')
    expect((lang.resource.language as { language_constant: string }).language_constant).toBe('languageConstants/1000')
  })

  it('caps new campaign budget at 1000/day and bounds bidding', () => {
    expect(CreateCampaignInputSchema.safeParse({
      name: 'X', daily_budget: 1500, bidding: { strategy: 'MANUAL_CPC' },
    }).success).toBe(false)
    expect(CreateCampaignInputSchema.safeParse({
      name: 'X', daily_budget: 500, bidding: { strategy: 'MANUAL_CPC' },
    }).success).toBe(true)
  })
})

describe('ad copy', () => {
  const valid = {
    campaign_id: 1, ad_group_id: 2,
    headlines: ['Licensed Electrician', '24/7 Emergency Callout', 'Upfront Fixed Quotes'],
    descriptions: ['Fast response across Sydney.', 'Call now for a fixed quote.'],
    final_url: 'https://example.com/emergency',
  }

  it('accepts a valid RSA and rejects http, path2-without-path1, and ! in headlines', () => {
    expect(AdCopyInputSchema.safeParse(valid).success).toBe(true)
    expect(AdCopyInputSchema.safeParse({ ...valid, final_url: 'http://example.com' }).success).toBe(false)
    expect(AdCopyInputSchema.safeParse({ ...valid, path2: 'sydney' }).success).toBe(false)
    expect(AdCopyInputSchema.safeParse({ ...valid, headlines: [...valid.headlines.slice(0, 2), 'Call Now!'] }).success).toBe(false)
  })

  it('rejects duplicate headlines case-insensitively', () => {
    expect(AdCopyInputSchema.safeParse({
      ...valid, headlines: ['Licensed Electrician', 'licensed electrician', 'Third One'],
    }).success).toBe(false)
  })

  it('create op is an ENABLED RSA; pause op targets the exact ad', () => {
    const input = AdCopyInputSchema.parse({ ...valid, path1: 'emergency' })
    const create = buildCreateRsaOp(CID, input)
    expect(create.operation).toBe('create')
    expect(create.resource.ad?.responsive_search_ad?.headlines).toHaveLength(3)
    expect(create.resource.ad?.responsive_search_ad?.path1).toBe('emergency')
    expect(create.resource.ad?.final_urls).toEqual(['https://example.com/emergency'])
    const pause = buildPauseAdOp(CID, 2, 777)
    expect(String(pause.resource.resource_name)).toBe(`customers/${CID}/adGroupAds/2~777`)
  })
})
