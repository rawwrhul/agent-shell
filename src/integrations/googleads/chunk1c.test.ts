// src/integrations/googleads/chunk1c.test.ts
//
// Pure-function coverage for the chunk 1c deterministic layers: device bid
// modifiers and keyword edits. No API, no network.

import { describe, it, expect } from 'vitest'
import { enums, toMicros } from 'google-ads-api'
import {
  BidModifiersInputSchema,
  buildBidModifierOps,
  MODIFIER_MIN,
  MODIFIER_MAX,
} from './bid-modifiers'
import {
  KeywordEditsInputSchema,
  buildKeywordEditOps,
  CPC_MIN,
  CPC_MAX,
} from './keyword-edits'

// ── Bid modifiers ────────────────────────────────────────────────────────

const bmBase = {
  campaign_id: 111,
  ad_group_id: 222,
  modifiers:   [{ device: 'MOBILE' as const, modifier: 1.25 }],
}

describe('BidModifiersInputSchema', () => {
  it('accepts a valid proposal and rounds to 2dp', () => {
    const r = BidModifiersInputSchema.safeParse({
      ...bmBase, modifiers: [{ device: 'MOBILE', modifier: 1.2567 }],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.modifiers[0].modifier).toBe(1.26)
  })

  it(`rejects a modifier below ${MODIFIER_MIN}`, () => {
    const r = BidModifiersInputSchema.safeParse({
      ...bmBase, modifiers: [{ device: 'MOBILE', modifier: 0.05 }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects a device opt-out (modifier 0)', () => {
    const r = BidModifiersInputSchema.safeParse({
      ...bmBase, modifiers: [{ device: 'TABLET', modifier: 0 }],
    })
    expect(r.success).toBe(false)
  })

  it(`rejects a modifier above ${MODIFIER_MAX}`, () => {
    const r = BidModifiersInputSchema.safeParse({
      ...bmBase, modifiers: [{ device: 'DESKTOP', modifier: 12 }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate devices in one proposal', () => {
    const r = BidModifiersInputSchema.safeParse({
      ...bmBase,
      modifiers: [
        { device: 'MOBILE', modifier: 1.2 },
        { device: 'MOBILE', modifier: 1.3 },
      ],
    })
    expect(r.success).toBe(false)
  })

  it('coerces string numbers from LLM JSON', () => {
    const r = BidModifiersInputSchema.safeParse({
      ...bmBase, campaign_id: '111', modifiers: [{ device: 'MOBILE', modifier: '1.5' }],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.modifiers[0].modifier).toBe(1.5)
  })
})

describe('buildBidModifierOps', () => {
  it('creates when the device has no existing modifier', () => {
    const parsed = BidModifiersInputSchema.parse(bmBase)
    const ops = buildBidModifierOps('1234567890', parsed, {})
    expect(ops).toHaveLength(1)
    expect(ops[0].operation).toBe('create')
    expect(ops[0].entity).toBe('ad_group_bid_modifier')
    expect(ops[0].resource.ad_group).toBe('customers/1234567890/adGroups/222')
    expect(ops[0].resource.device?.type).toBe(enums.Device.MOBILE)
    expect(ops[0].resource.bid_modifier).toBe(1.25)
  })

  it('updates via resource_name when the device already has a modifier', () => {
    const parsed = BidModifiersInputSchema.parse(bmBase)
    const ops = buildBidModifierOps('1234567890', parsed, {
      MOBILE: { criterionId: '30001', modifier: 1.1 },
    })
    expect(ops[0].operation).toBe('update')
    expect(ops[0].resource.resource_name).toBe('customers/1234567890/adGroupBidModifiers/222~30001')
    expect(ops[0].resource.bid_modifier).toBe(1.25)
    expect(ops[0].resource.ad_group).toBeUndefined()
  })
})

// ── Keyword edits ────────────────────────────────────────────────────────

const keBase = {
  campaign_id: 111,
  ad_group_id: 222,
  edits:       [{ criterion_id: 333, action: 'pause' as const }],
}

describe('KeywordEditsInputSchema', () => {
  it('accepts pause and enable without cpc', () => {
    expect(KeywordEditsInputSchema.safeParse(keBase).success).toBe(true)
    expect(KeywordEditsInputSchema.safeParse({
      ...keBase, edits: [{ criterion_id: 333, action: 'enable' }],
    }).success).toBe(true)
  })

  it('requires cpc for set_cpc', () => {
    const r = KeywordEditsInputSchema.safeParse({
      ...keBase, edits: [{ criterion_id: 333, action: 'set_cpc' }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects cpc on pause/enable', () => {
    const r = KeywordEditsInputSchema.safeParse({
      ...keBase, edits: [{ criterion_id: 333, action: 'pause', cpc: 1.5 }],
    })
    expect(r.success).toBe(false)
  })

  it(`bounds cpc to [${CPC_MIN}, ${CPC_MAX}]`, () => {
    expect(KeywordEditsInputSchema.safeParse({
      ...keBase, edits: [{ criterion_id: 333, action: 'set_cpc', cpc: 0.01 }],
    }).success).toBe(false)
    expect(KeywordEditsInputSchema.safeParse({
      ...keBase, edits: [{ criterion_id: 333, action: 'set_cpc', cpc: 500 }],
    }).success).toBe(false)
    expect(KeywordEditsInputSchema.safeParse({
      ...keBase, edits: [{ criterion_id: 333, action: 'set_cpc', cpc: 2.4 }],
    }).success).toBe(true)
  })

  it('rejects duplicate criterion ids', () => {
    const r = KeywordEditsInputSchema.safeParse({
      ...keBase,
      edits: [
        { criterion_id: 333, action: 'pause' },
        { criterion_id: 333, action: 'enable' },
      ],
    })
    expect(r.success).toBe(false)
  })
})

describe('buildKeywordEditOps', () => {
  it('builds a status update for pause with the tilde resource name', () => {
    const parsed = KeywordEditsInputSchema.parse(keBase)
    const ops = buildKeywordEditOps('1234567890', parsed)
    expect(ops[0].entity).toBe('ad_group_criterion')
    expect(ops[0].operation).toBe('update')
    expect(ops[0].resource.resource_name).toBe('customers/1234567890/adGroupCriteria/222~333')
    expect(ops[0].resource.status).toBe(enums.AdGroupCriterionStatus.PAUSED)
    expect(ops[0].resource.cpc_bid_micros).toBeUndefined()
  })

  it('converts cpc to micros deterministically for set_cpc', () => {
    const parsed = KeywordEditsInputSchema.parse({
      ...keBase, edits: [{ criterion_id: 333, action: 'set_cpc', cpc: 2.5 }],
    })
    const ops = buildKeywordEditOps('1234567890', parsed)
    expect(ops[0].resource.cpc_bid_micros).toBe(toMicros(2.5))
    expect(ops[0].resource.cpc_bid_micros).toBe(2_500_000)
    expect(ops[0].resource.status).toBeUndefined()
  })

  it('respects a filtered edit subset (executor pre-read path)', () => {
    const parsed = KeywordEditsInputSchema.parse({
      ...keBase,
      edits: [
        { criterion_id: 333, action: 'pause' },
        { criterion_id: 444, action: 'enable' },
      ],
    })
    const ops = buildKeywordEditOps('1234567890', parsed, [parsed.edits[1]])
    expect(ops).toHaveLength(1)
    expect(ops[0].resource.resource_name).toContain('222~444')
  })
})
