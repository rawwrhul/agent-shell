// src/integrations/googleads/negatives.test.ts
//
// Pure-function coverage for the chunk 1b deterministic layer. No API, no
// network - validates the schema gate and the mutation op builders that sit
// between the LLM proposal and the Google Ads API.

import { describe, it, expect } from 'vitest'
import {
  NegativeKeywordsInputSchema,
  dedupeKeywords,
  buildCampaignNegativeOps,
  buildAdGroupNegativeOps,
  MAX_NEGATIVES_PER_PROPOSAL,
} from './negatives'
import { enums } from 'google-ads-api'

const base = {
  scope:       'ad_group' as const,
  campaign_id: 111,
  ad_group_id: 222,
  keywords:    [{ text: 'free electrician course', match_type: 'PHRASE' as const }],
}

describe('NegativeKeywordsInputSchema', () => {
  it('accepts a valid ad_group proposal', () => {
    const r = NegativeKeywordsInputSchema.safeParse(base)
    expect(r.success).toBe(true)
  })

  it('accepts a valid campaign proposal without ad_group_id', () => {
    const r = NegativeKeywordsInputSchema.safeParse({ ...base, scope: 'campaign', ad_group_id: undefined })
    expect(r.success).toBe(true)
  })

  it('rejects ad_group scope without ad_group_id', () => {
    const r = NegativeKeywordsInputSchema.safeParse({ ...base, ad_group_id: undefined })
    expect(r.success).toBe(false)
  })

  it('coerces string ids from LLM JSON', () => {
    const r = NegativeKeywordsInputSchema.safeParse({ ...base, campaign_id: '111', ad_group_id: '222' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.campaign_id).toBe(111)
  })

  it('normalises whitespace in keyword text', () => {
    const r = NegativeKeywordsInputSchema.safeParse({
      ...base, keywords: [{ text: '  free   course  ', match_type: 'EXACT' }],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.keywords[0].text).toBe('free course')
  })

  it('rejects keyword text with characters Google Ads rejects', () => {
    const r = NegativeKeywordsInputSchema.safeParse({
      ...base, keywords: [{ text: 'free! course', match_type: 'EXACT' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects an empty keywords array', () => {
    const r = NegativeKeywordsInputSchema.safeParse({ ...base, keywords: [] })
    expect(r.success).toBe(false)
  })

  it(`rejects more than ${MAX_NEGATIVES_PER_PROPOSAL} keywords`, () => {
    const many = Array.from({ length: MAX_NEGATIVES_PER_PROPOSAL + 1 }, (_, i) => ({
      text: `term ${i}`, match_type: 'BROAD' as const,
    }))
    const r = NegativeKeywordsInputSchema.safeParse({ ...base, keywords: many })
    expect(r.success).toBe(false)
  })

  it('rejects an invalid match type', () => {
    const r = NegativeKeywordsInputSchema.safeParse({
      ...base, keywords: [{ text: 'free course', match_type: 'NEAR_EXACT' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a keyword over the word limit', () => {
    const r = NegativeKeywordsInputSchema.safeParse({
      ...base, keywords: [{ text: 'a b c d e f g h i j k', match_type: 'BROAD' }],
    })
    expect(r.success).toBe(false)
  })
})

describe('dedupeKeywords', () => {
  it('drops case-insensitive duplicates on text plus match type', () => {
    const out = dedupeKeywords([
      { text: 'Free Course', match_type: 'EXACT' },
      { text: 'free course', match_type: 'EXACT' },
      { text: 'free course', match_type: 'PHRASE' },
    ])
    expect(out).toHaveLength(2)
  })
})

describe('op builders', () => {
  it('builds ad_group_criterion create ops with negative=true and correct resource name', () => {
    const parsed = NegativeKeywordsInputSchema.parse(base)
    const ops = buildAdGroupNegativeOps('1234567890', parsed)
    expect(ops).toHaveLength(1)
    expect(ops[0].entity).toBe('ad_group_criterion')
    expect(ops[0].operation).toBe('create')
    expect(ops[0].resource.ad_group).toBe('customers/1234567890/adGroups/222')
    expect(ops[0].resource.negative).toBe(true)
    expect(ops[0].resource.keyword?.match_type).toBe(enums.KeywordMatchType.PHRASE)
    expect(ops[0].resource.keyword?.text).toBe('free electrician course')
  })

  it('builds campaign_criterion create ops with correct resource name', () => {
    const parsed = NegativeKeywordsInputSchema.parse({ ...base, scope: 'campaign', ad_group_id: undefined })
    const ops = buildCampaignNegativeOps('1234567890', parsed)
    expect(ops[0].entity).toBe('campaign_criterion')
    expect(ops[0].resource.campaign).toBe('customers/1234567890/campaigns/111')
    expect(ops[0].resource.negative).toBe(true)
  })

  it('dedupes inside the builder', () => {
    const parsed = NegativeKeywordsInputSchema.parse({
      ...base,
      keywords: [
        { text: 'dup term', match_type: 'EXACT' },
        { text: 'DUP TERM', match_type: 'EXACT' },
      ],
    })
    const ops = buildAdGroupNegativeOps('1234567890', parsed)
    expect(ops).toHaveLength(1)
  })
})
