// src/integrations/googleads/executor.ts
//
// Execution-path handlers for approved Google Ads actions. These run ONLY
// via src/execution/dispatcher.ts after an operator approves the HITL
// request - never from the agent tool layer. ctx.approvalId is what
// unlocks TenantAdsClient.mutate.
//
// Failure semantics (matches the worker's contract):
//   - Validation failures return { ok: false } - terminal, no retry.
//   - API throws propagate - the worker's classifyExecutionError decides
//     retry (transient) vs UnrecoverableError (permanent).

import { logger } from '../../logger'
import type { IntegrationContext, ExecutionResult } from '../types'
import { forTenant } from './client'
import { enums } from 'google-ads-api'
import {
  NegativeKeywordsInputSchema,
  buildCampaignNegativeOps,
  buildAdGroupNegativeOps,
  dedupeKeywords,
} from './negatives'
import { BidModifiersInputSchema, buildBidModifierOps, type ExistingModifiers, type DeviceNameT } from './bid-modifiers'
import { KeywordEditsInputSchema, buildKeywordEditOps, type KeywordEdit } from './keyword-edits'

export async function execAdsAddNegativeKeywords(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) {
    return {
      ok: false,
      summary: 'Blocked: ads mutations require the HITL execution path (no approvalId in context).',
      error:   'missing_approval_id',
    }
  }

  const parsed = NegativeKeywordsInputSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return {
      ok: false,
      summary: `Negative keywords proposal failed validation: ${msg}`,
      error:   `validation_failed: ${msg}`,
    }
  }
  const nk = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  // Pre-mutate dedupe against negatives ALREADY on the target. Without
  // this, re-approving a duplicate proposal throws a permanent API error;
  // with it, idempotent re-approval succeeds cleanly.
  const existing = new Set<string>()
  try {
    const rows = nk.scope === 'campaign'
      ? await client.query(`
          SELECT campaign_criterion.keyword.text, campaign_criterion.keyword.match_type
          FROM campaign_criterion
          WHERE campaign_criterion.negative = TRUE
            AND campaign_criterion.type = 'KEYWORD'
            AND campaign_criterion.status != 'REMOVED'
            AND campaign.id = ${nk.campaign_id}`, 'negatives_dedupe')
      : await client.query(`
          SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
          FROM ad_group_criterion
          WHERE ad_group_criterion.negative = TRUE
            AND ad_group_criterion.type = 'KEYWORD'
            AND ad_group_criterion.status != 'REMOVED'
            AND ad_group.id = ${nk.ad_group_id}`, 'negatives_dedupe')
    for (const r of rows) {
      const kw = (r as Record<string, { keyword?: { text?: string; match_type?: unknown } }>)[
        nk.scope === 'campaign' ? 'campaign_criterion' : 'ad_group_criterion'
      ]?.keyword
      if (kw?.text) existing.add(`${matchTypeName(kw.match_type)}:${kw.text.toLowerCase()}`)
    }
  } catch (err) {
    logger.warn('ads_negatives_dedupe_read_failed', {
      tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
      err: String(err).slice(0, 200),
      hint: 'Proceeding without dedupe; a true duplicate will surface as a permanent API error.',
    })
  }

  const proposed = dedupeKeywords(nk.keywords)
  const shipped = proposed.filter((k) => !existing.has(`${k.match_type}:${k.text.toLowerCase()}`))
  const skipped = proposed.length - shipped.length

  if (shipped.length === 0) {
    return {
      ok: true,
      summary: `All ${proposed.length} proposed negative keyword(s) already exist on the target - nothing to add.`,
      detail: {
        scope: nk.scope, campaign_id: nk.campaign_id, ad_group_id: nk.ad_group_id ?? null,
        keywords: [], skipped_existing: skipped, resource_names: [], rationale: nk.rationale ?? null,
      },
    }
  }

  const nkShipped = { ...nk, keywords: shipped }

  let res: Awaited<ReturnType<typeof client.mutate>>
  if (nk.scope === 'campaign') {
    const ops = buildCampaignNegativeOps(client.customerId, nkShipped)
    res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'add_negative_keywords' })
  } else {
    const ops = buildAdGroupNegativeOps(client.customerId, nkShipped)
    res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'add_negative_keywords' })
  }

  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.campaign_criterion_result?.resource_name ?? r.ad_group_criterion_result?.resource_name)
    .filter((x): x is string => !!x)

  const scopeLabel = nk.scope === 'campaign'
    ? `campaign ${nk.campaign_id}`
    : `ad group ${nk.ad_group_id} (campaign ${nk.campaign_id})`

  logger.info('ads_negatives_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    scope: nk.scope, campaignId: nk.campaign_id, adGroupId: nk.ad_group_id ?? null,
    count: shipped.length, skipped,
  })

  const skippedPart = skipped ? ` (${skipped} already existed, skipped)` : ''

  return {
    ok: true,
    summary: `Added ${shipped.length} negative keyword${shipped.length === 1 ? '' : 's'} at ${scopeLabel} via the Google Ads API.${skippedPart}`,
    detail: {
      scope:            nk.scope,
      campaign_id:      nk.campaign_id,
      ad_group_id:      nk.ad_group_id ?? null,
      keywords:         shipped.map((k) => ({ text: k.text, match_type: k.match_type })),
      skipped_existing: skipped,
      resource_names:   resourceNames,
      rationale:        nk.rationale ?? null,
    },
  }
}

/** Normalise the API's match_type (enum number or string) to the schema's string names. */
function matchTypeName(v: unknown): string {
  if (v === 2 || v === 'EXACT')  return 'EXACT'
  if (v === 3 || v === 'PHRASE') return 'PHRASE'
  if (v === 4 || v === 'BROAD')  return 'BROAD'
  return String(v)
}

// ── Chunk 1c: device bid modifiers ──────────────────────────────────────

export async function execAdsSetBidModifiers(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) {
    return {
      ok: false,
      summary: 'Blocked: ads mutations require the HITL execution path (no approvalId in context).',
      error:   'missing_approval_id',
    }
  }

  const parsed = BidModifiersInputSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return {
      ok: false,
      summary: `Bid modifiers proposal failed validation: ${msg}`,
      error:   `validation_failed: ${msg}`,
    }
  }
  const bm = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  // Pre-read: which devices already have a modifier on this ad group.
  // Routes each device to update (exists) or create (does not) - a blind
  // create on an existing device throws BID_MODIFIER_ALREADY_EXISTS.
  const existing: ExistingModifiers = {}
  const rows = await client.query(`
    SELECT ad_group_bid_modifier.criterion_id, ad_group_bid_modifier.bid_modifier,
           ad_group_bid_modifier.device.type
    FROM ad_group_bid_modifier
    WHERE ad_group.id = ${bm.ad_group_id}`, 'bid_modifiers_preread')
  for (const r of rows) {
    const mod = r.ad_group_bid_modifier
    const device = deviceName(mod?.device?.type)
    if (device && mod?.criterion_id != null) {
      existing[device] = { criterionId: String(mod.criterion_id), modifier: Number(mod.bid_modifier ?? 1) }
    }
  }

  const ops = buildBidModifierOps(client.customerId, bm, existing)
  const res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'set_bid_modifiers' })

  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.ad_group_bid_modifier_result?.resource_name)
    .filter((x): x is string => !!x)

  const changes = bm.modifiers.map((m) => {
    const prior = existing[m.device]
    const priorPart = prior ? `${prior.modifier}x -> ` : ''
    return `${m.device} ${priorPart}${m.modifier}x`
  })

  logger.info('ads_bid_modifiers_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    campaignId: bm.campaign_id, adGroupId: bm.ad_group_id, changes,
  })

  return {
    ok: true,
    summary: `Set device bid modifiers on ad group ${bm.ad_group_id}: ${changes.join(', ')}`,
    detail: {
      campaign_id:    bm.campaign_id,
      ad_group_id:    bm.ad_group_id,
      modifiers:      bm.modifiers.map((m) => ({
        device: m.device, modifier: m.modifier,
        previous: existing[m.device]?.modifier ?? null,
      })),
      resource_names: resourceNames,
      rationale:      bm.rationale ?? null,
    },
  }
}

// ── Chunk 1c: edit active keywords (pause / enable / set_cpc) ───────────

export async function execAdsEditKeywords(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) {
    return {
      ok: false,
      summary: 'Blocked: ads mutations require the HITL execution path (no approvalId in context).',
      error:   'missing_approval_id',
    }
  }

  const parsed = KeywordEditsInputSchema.safeParse(input)
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    return {
      ok: false,
      summary: `Keyword edits proposal failed validation: ${msg}`,
      error:   `validation_failed: ${msg}`,
    }
  }
  const ke = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  // Pre-read: confirm each criterion exists on the target ad group, is a
  // positive keyword, and capture before-state for the audit detail. Edits
  // whose target is missing or negative are skipped, not failed - the
  // account may have changed between proposal and approval.
  const found = new Map<number, { text?: string; matchType?: unknown; status?: unknown; negative?: boolean; biddingStrategy?: unknown }>()
  const ids = ke.edits.map((e) => e.criterion_id).join(',')
  const rows = await client.query(`
    SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
           ad_group_criterion.keyword.match_type, ad_group_criterion.status,
           ad_group_criterion.negative, campaign.bidding_strategy_type
    FROM ad_group_criterion
    WHERE ad_group.id = ${ke.ad_group_id}
      AND ad_group_criterion.type = 'KEYWORD'
      AND ad_group_criterion.criterion_id IN (${ids})`, 'keyword_edits_preread')
  let biddingStrategy: unknown = null
  for (const r of rows) {
    const c = r.ad_group_criterion
    biddingStrategy = r.campaign?.bidding_strategy_type ?? biddingStrategy
    if (c?.criterion_id != null) {
      found.set(Number(c.criterion_id), {
        text: c.keyword?.text ?? undefined, matchType: c.keyword?.match_type,
        status: c.status, negative: !!c.negative,
      })
    }
  }

  const applicable = ke.edits.filter((e) => {
    const f = found.get(e.criterion_id)
    return f != null && !f.negative
  })
  const skipped = ke.edits.filter((e) => !applicable.includes(e))
    .map((e) => ({ criterion_id: e.criterion_id, reason: found.has(e.criterion_id) ? 'negative_criterion' : 'not_found_on_ad_group' }))

  if (applicable.length === 0) {
    return {
      ok: false,
      summary: `None of the ${ke.edits.length} keyword edit target(s) exist as positive keywords on ad group ${ke.ad_group_id}.`,
      error:   `no_applicable_edits: ${JSON.stringify(skipped)}`,
    }
  }

  const strategyName = String(biddingStrategy ?? '')
  const cpcOnSmartBidding = applicable.some((e) => e.action === 'set_cpc') &&
    !['MANUAL_CPC', String(enums.BiddingStrategyType.MANUAL_CPC)].includes(strategyName)

  const ops = buildKeywordEditOps(client.customerId, ke, applicable)
  const res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'edit_keywords' })

  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.ad_group_criterion_result?.resource_name)
    .filter((x): x is string => !!x)

  const describe = (e: KeywordEdit) => {
    const f = found.get(e.criterion_id)
    const label = f?.text ? `"${f.text}"` : `#${e.criterion_id}`
    return e.action === 'set_cpc' ? `${label} cpc -> ${e.cpc}` : `${label} ${e.action}`
  }

  logger.info('ads_keyword_edits_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    campaignId: ke.campaign_id, adGroupId: ke.ad_group_id,
    applied: applicable.length, skipped: skipped.length, cpcOnSmartBidding,
  })

  const warnPart = cpcOnSmartBidding
    ? ` WARNING: campaign bidding strategy is ${strategyName || 'not MANUAL_CPC'} - keyword CPC bids are stored but ignored under Smart Bidding.`
    : ''
  const skippedPart = skipped.length ? ` (${skipped.length} skipped: missing or negative)` : ''

  return {
    ok: true,
    summary: `Applied ${applicable.length} keyword edit${applicable.length === 1 ? '' : 's'} on ad group ${ke.ad_group_id}: ${applicable.map(describe).join(', ')}.${skippedPart}${warnPart}`,
    detail: {
      campaign_id:    ke.campaign_id,
      ad_group_id:    ke.ad_group_id,
      applied:        applicable.map((e) => ({
        criterion_id: e.criterion_id, action: e.action, cpc: e.cpc ?? null,
        keyword: found.get(e.criterion_id)?.text ?? null,
        previous_status: String(found.get(e.criterion_id)?.status ?? ''),
      })),
      skipped,
      cpc_on_smart_bidding: cpcOnSmartBidding,
      resource_names: resourceNames,
      rationale:      ke.rationale ?? null,
    },
  }
}

/** Normalise the API's device type (enum number or string) to schema names. */
function deviceName(v: unknown): DeviceNameT | null {
  if (v === 2 || v === 'MOBILE')  return 'MOBILE'
  if (v === 4 || v === 'DESKTOP') return 'DESKTOP'
  if (v === 3 || v === 'TABLET')  return 'TABLET'
  return null
}
