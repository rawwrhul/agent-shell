// src/skills/ads/tools.test.ts
//
// Guards the two invariants that make the ads skill safe to evolve:
//
//   1. Skill <-> dispatcher consistency. Every toolName the skill offers
//      the agent must be a registered executor, and every ads_* executor
//      must be proposable - a drift in either direction produces dead
//      approve buttons or unreachable executors.
//   2. The proposal-time validation gate uses the executors' own schemas,
//      so malformed input is rejected at filing time with actionable
//      messages.

import { describe, it, expect } from 'vitest'
import { ADS_ACTION_TOOL_NAMES, ADS_SKILL_TOOLS, isAdsSkillToolName, WRITE_SIDE_ADS_TOOL_NAMES } from './tools'
import { isExecutableToolName } from '../../execution/dispatcher'
import { NegativeKeywordsInputSchema } from '../../integrations/googleads/negatives'
import { BidChangeInputSchema } from '../../integrations/googleads/bid-changes'
import { BudgetChangeInputSchema } from '../../integrations/googleads/budget-changes'
import { AdCopyInputSchema } from '../../integrations/googleads/ad-copy'

describe('skill <-> dispatcher consistency', () => {
  it('every proposable ads action is a registered executor', () => {
    for (const name of ADS_ACTION_TOOL_NAMES) {
      expect(isExecutableToolName(name), `${name} missing from dispatcher HANDLERS`).toBe(true)
    }
  })

  it('covers all nine action types', () => {
    expect(ADS_ACTION_TOOL_NAMES.sort()).toEqual([
      'ads_add_keywords',
      'ads_add_negative_keywords',
      'ads_change_bids',
      'ads_change_budget',
      'ads_create_ad_group',
      'ads_create_campaign',
      'ads_edit_keywords',
      'ads_set_bid_modifiers',
      'ads_update_ad_copy',
    ])
  })

  it('propose_ads_action is write-side; the approvals query is not', () => {
    expect(WRITE_SIDE_ADS_TOOL_NAMES.has('propose_ads_action')).toBe(true)
    expect(WRITE_SIDE_ADS_TOOL_NAMES.has('query_pending_ads_approvals')).toBe(false)
  })

  it('skill tool names are distinct from the seo skill propose_action', () => {
    expect(isAdsSkillToolName('propose_ads_action')).toBe(true)
    expect(isAdsSkillToolName('propose_action')).toBe(false)
  })

  it('the propose tool enumerates exactly the registered executor names', () => {
    const tool = ADS_SKILL_TOOLS.find((t) => t.name === 'propose_ads_action')!
    const props = (tool.input_schema as { properties: { toolName: { enum: string[] } } }).properties
    expect(props.toolName.enum.sort()).toEqual([...ADS_ACTION_TOOL_NAMES].sort())
  })
})

describe('proposal-time validation uses the executor schemas', () => {
  it('accepts a valid negatives proposal', () => {
    const r = NegativeKeywordsInputSchema.safeParse({
      scope: 'ad_group', campaign_id: 1, ad_group_id: 2,
      keywords: [{ text: 'free course', match_type: 'PHRASE' }],
    })
    expect(r.success).toBe(true)
  })

  it('rejects a bid change over the 30% step cap only at execution (schema bounds still apply)', () => {
    const r = BidChangeInputSchema.safeParse({ field: 'target_cpa', campaign_id: 1, new_target: 50000 })
    expect(r.success).toBe(false)
  })

  it('rejects a budget outside bounds', () => {
    expect(BudgetChangeInputSchema.safeParse({ campaign_id: 1, new_daily_budget: 0.5 }).success).toBe(false)
    expect(BudgetChangeInputSchema.safeParse({ campaign_id: 1, new_daily_budget: 50000 }).success).toBe(false)
    expect(BudgetChangeInputSchema.safeParse({ campaign_id: 1, new_daily_budget: 150 }).success).toBe(true)
  })

  it('rejects ad copy with an http final_url or missing headline minimum', () => {
    expect(AdCopyInputSchema.safeParse({
      campaign_id: 1, ad_group_id: 2,
      headlines: ['One', 'Two', 'Three'],
      descriptions: ['A description here.', 'Another description.'],
      final_url: 'http://example.com',
    }).success).toBe(false)
    expect(AdCopyInputSchema.safeParse({
      campaign_id: 1, ad_group_id: 2,
      headlines: ['One', 'Two'],
      descriptions: ['A description here.', 'Another description.'],
      final_url: 'https://example.com',
    }).success).toBe(false)
  })
})
