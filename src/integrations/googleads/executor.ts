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
import { fromMicros } from 'google-ads-api'
import {
  BidChangeInputSchema, relativeStep, buildCampaignTargetOp, buildAdGroupCpcOp,
  MAX_RELATIVE_BID_STEP, type CampaignTargetKind,
} from './bid-changes'
import {
  BudgetChangeInputSchema, diagnoseBudgetIncrease, buildBudgetUpdateOp,
  MAX_RELATIVE_BUDGET_STEP, BUDGET_LOST_IS_FLOOR,
} from './budget-changes'
import {
  AddKeywordsInputSchema, buildAddKeywordOps, dedupePositiveKeywords,
  CreateAdGroupInputSchema, buildCreateAdGroupOps,
  CreateCampaignInputSchema, buildCreateCampaignOps,
} from './expansion'
import { AdCopyInputSchema, buildCreateRsaOp, buildPauseAdOp } from './ad-copy'

/** Uniform "not on the HITL execution path" refusal. */
function blockedNoApproval(): ExecutionResult {
  return {
    ok: false,
    summary: 'Blocked: ads mutations require the HITL execution path (no approvalId in context).',
    error:   'missing_approval_id',
  }
}

/** Uniform zod failure -> terminal ExecutionResult. */
function validationFailure(label: string, error: { issues: { path: (string | number)[]; message: string }[] }): ExecutionResult {
  const msg = error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
  return {
    ok: false,
    summary: `${label} proposal failed validation: ${msg}`,
    error:   `validation_failed: ${msg}`,
  }
}

/** Escape a string for use inside a single-quoted GAQL literal. */
function gaqlEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** Normalise an API enum (number or string) to its string name. */
function enumName(e: Record<string | number, string | number>, v: unknown): string {
  if (typeof v === 'number') return String(e[v] ?? v)
  return String(v ?? '')
}

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

// ── Chunk 1d: bid changes (tCPA / tROAS / ad group CPC) ─────────────────

export async function execAdsChangeBids(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) return blockedNoApproval()

  const parsed = BidChangeInputSchema.safeParse(input)
  if (!parsed.success) return validationFailure('Bid change', parsed.error)
  const bc = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  if (bc.field === 'ad_group_cpc') {
    const rows = await client.query(`
      SELECT ad_group.id, ad_group.status, ad_group.cpc_bid_micros,
             campaign.bidding_strategy_type
      FROM ad_group
      WHERE ad_group.id = ${bc.ad_group_id} AND campaign.id = ${bc.campaign_id}`, 'bid_change_preread')
    const row = rows[0]
    if (!row?.ad_group?.id) {
      return {
        ok: false,
        summary: `Ad group ${bc.ad_group_id} not found on campaign ${bc.campaign_id}.`,
        error:   'ad_group_not_found',
      }
    }
    const strategy = enumName(enums.BiddingStrategyType, row.campaign?.bidding_strategy_type)
    if (strategy !== 'MANUAL_CPC') {
      return {
        ok: false,
        summary: `Refused: campaign ${bc.campaign_id} bidding strategy is ${strategy || 'unknown'} - ad group CPC only applies on MANUAL_CPC campaigns. Propose the matching target change instead.`,
        error:   'wrong_lever_not_manual_cpc',
      }
    }

    const currentMicros = Number(row.ad_group.cpc_bid_micros ?? 0)
    const current = currentMicros > 0 ? fromMicros(currentMicros) : null
    if (current != null) {
      const step = relativeStep(current, bc.new_cpc)
      if (step > MAX_RELATIVE_BID_STEP) {
        return {
          ok: false,
          summary: `Refused: CPC move ${current} -> ${bc.new_cpc} is a ${Math.round(step * 100)}% step; the cap is ${MAX_RELATIVE_BID_STEP * 100}% per approval. Propose an intermediate value and step again in a few days.`,
          error:   'step_cap_exceeded',
        }
      }
    }

    const res = await client.mutate([buildAdGroupCpcOp(client.customerId, bc.ad_group_id, bc.new_cpc)],
      { approvalId: ctx.approvalId, label: 'change_bids' })
    const resourceNames = (res.mutate_operation_responses ?? [])
      .map((r) => r.ad_group_result?.resource_name)
      .filter((x): x is string => !!x)

    logger.info('ads_bid_change_shipped', {
      tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
      field: bc.field, campaignId: bc.campaign_id, adGroupId: bc.ad_group_id,
      previous: current, next: bc.new_cpc,
    })
    const fromPart = current != null ? `${current} -> ` : '(no prior default bid) -> '
    return {
      ok: true,
      summary: `Set ad group ${bc.ad_group_id} default CPC ${fromPart}${bc.new_cpc} via the Google Ads API.`,
      detail: {
        field: bc.field, campaign_id: bc.campaign_id, ad_group_id: bc.ad_group_id,
        previous: current, next: bc.new_cpc, resource_names: resourceNames,
        rationale: bc.rationale ?? null,
      },
    }
  }

  // Campaign-level target move (tCPA or tROAS).
  const rows = await client.query(`
    SELECT campaign.id, campaign.status, campaign.bidding_strategy,
           campaign.bidding_strategy_type,
           campaign.target_cpa.target_cpa_micros,
           campaign.maximize_conversions.target_cpa_micros,
           campaign.target_roas.target_roas,
           campaign.maximize_conversion_value.target_roas
    FROM campaign
    WHERE campaign.id = ${bc.campaign_id}`, 'bid_change_preread')
  const row = rows[0]
  if (!row?.campaign?.id) {
    return { ok: false, summary: `Campaign ${bc.campaign_id} not found.`, error: 'campaign_not_found' }
  }
  const c = row.campaign
  if (enumName(enums.CampaignStatus, c.status) === 'REMOVED') {
    return { ok: false, summary: `Campaign ${bc.campaign_id} is removed.`, error: 'campaign_removed' }
  }
  if (c.bidding_strategy) {
    return {
      ok: false,
      summary: `Refused: campaign ${bc.campaign_id} uses portfolio bidding strategy ${String(c.bidding_strategy)} - moving it would affect every attached campaign. Flag as a manual operator task.`,
      error:   'portfolio_strategy',
    }
  }

  const strategy = enumName(enums.BiddingStrategyType, c.bidding_strategy_type)
  let kind: CampaignTargetKind
  let current: number | null

  if (bc.field === 'target_cpa') {
    if (strategy === 'TARGET_CPA') {
      kind = 'target_cpa'
      const micros = Number(c.target_cpa?.target_cpa_micros ?? 0)
      current = micros > 0 ? fromMicros(micros) : null
    } else if (strategy === 'MAXIMIZE_CONVERSIONS') {
      const micros = Number(c.maximize_conversions?.target_cpa_micros ?? 0)
      if (micros <= 0) {
        return {
          ok: false,
          summary: `Refused: campaign ${bc.campaign_id} runs targetless MAXIMIZE_CONVERSIONS - there is no tCPA to move. Route aggression to ads_change_budget instead.`,
          error:   'targetless_strategy',
        }
      }
      kind = 'maximize_conversions_with_tcpa'
      current = fromMicros(micros)
    } else {
      return {
        ok: false,
        summary: `Refused: campaign ${bc.campaign_id} bidding strategy is ${strategy || 'unknown'} - target_cpa does not apply. Read the campaign first and propose the matching field.`,
        error:   'strategy_mismatch',
      }
    }
  } else {
    if (strategy === 'TARGET_ROAS') {
      kind = 'target_roas'
      const v = Number(c.target_roas?.target_roas ?? 0)
      current = v > 0 ? v : null
    } else if (strategy === 'MAXIMIZE_CONVERSION_VALUE') {
      const v = Number(c.maximize_conversion_value?.target_roas ?? 0)
      if (v <= 0) {
        return {
          ok: false,
          summary: `Refused: campaign ${bc.campaign_id} runs targetless MAXIMIZE_CONVERSION_VALUE - there is no tROAS to move. Route aggression to ads_change_budget instead.`,
          error:   'targetless_strategy',
        }
      }
      kind = 'maximize_conversion_value_with_troas'
      current = v
    } else {
      return {
        ok: false,
        summary: `Refused: campaign ${bc.campaign_id} bidding strategy is ${strategy || 'unknown'} - target_roas does not apply. Read the campaign first and propose the matching field.`,
        error:   'strategy_mismatch',
      }
    }
  }

  if (current == null) {
    return {
      ok: false,
      summary: `Refused: campaign ${bc.campaign_id} has no current ${bc.field} to step from. Set the initial target in the Google Ads UI (manual operator task).`,
      error:   'no_baseline_target',
    }
  }

  const step = relativeStep(current, bc.new_target)
  if (step > MAX_RELATIVE_BID_STEP) {
    return {
      ok: false,
      summary: `Refused: ${bc.field} move ${current} -> ${bc.new_target} is a ${Math.round(step * 100)}% step; the cap is ${MAX_RELATIVE_BID_STEP * 100}% per approval. Propose an intermediate value and step again in a few days.`,
      error:   'step_cap_exceeded',
    }
  }

  const res = await client.mutate([buildCampaignTargetOp(client.customerId, bc.campaign_id, kind, bc.new_target)],
    { approvalId: ctx.approvalId, label: 'change_bids' })
  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.campaign_result?.resource_name)
    .filter((x): x is string => !!x)

  logger.info('ads_bid_change_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    field: bc.field, campaignId: bc.campaign_id, strategy, kind,
    previous: current, next: bc.new_target,
  })
  return {
    ok: true,
    summary: `Moved ${bc.field} on campaign ${bc.campaign_id} (${strategy}): ${current} -> ${bc.new_target} via the Google Ads API.`,
    detail: {
      field: bc.field, campaign_id: bc.campaign_id, strategy, target_kind: kind,
      previous: current, next: bc.new_target, resource_names: resourceNames,
      rationale: bc.rationale ?? null,
    },
  }
}

// ── Chunk 1d: campaign daily budget ─────────────────────────────────────

export async function execAdsChangeBudget(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) return blockedNoApproval()

  const parsed = BudgetChangeInputSchema.safeParse(input)
  if (!parsed.success) return validationFailure('Budget change', parsed.error)
  const bch = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  const rows = await client.query(`
    SELECT campaign.id, campaign.status,
           campaign_budget.resource_name, campaign_budget.amount_micros,
           campaign_budget.explicitly_shared
    FROM campaign
    WHERE campaign.id = ${bch.campaign_id}`, 'budget_change_preread')
  const row = rows[0]
  if (!row?.campaign?.id || !row.campaign_budget?.resource_name) {
    return { ok: false, summary: `Campaign ${bch.campaign_id} (or its budget) not found.`, error: 'campaign_not_found' }
  }
  if (enumName(enums.CampaignStatus, row.campaign.status) === 'REMOVED') {
    return { ok: false, summary: `Campaign ${bch.campaign_id} is removed.`, error: 'campaign_removed' }
  }
  if (row.campaign_budget.explicitly_shared) {
    return {
      ok: false,
      summary: `Refused: campaign ${bch.campaign_id} uses a SHARED budget - changing it changes every attached campaign. Flag as a manual operator task.`,
      error:   'shared_budget',
    }
  }

  const current = fromMicros(Number(row.campaign_budget.amount_micros ?? 0))
  if (!(current > 0)) {
    return { ok: false, summary: `Campaign ${bch.campaign_id} has no readable current budget.`, error: 'no_baseline_budget' }
  }

  const step = relativeStep(current, bch.new_daily_budget)
  if (step > MAX_RELATIVE_BUDGET_STEP) {
    return {
      ok: false,
      summary: `Refused: budget move ${current} -> ${bch.new_daily_budget} is a ${Math.round(step * 100)}% step; the cap is ${MAX_RELATIVE_BUDGET_STEP * 100}% per approval. Propose an intermediate value.`,
      error:   'step_cap_exceeded',
    }
  }

  const isIncrease = bch.new_daily_budget > current
  let budgetLostIs = 0
  let rankLostIs = 0
  if (isIncrease) {
    const mrows = await client.query(`
      SELECT metrics.search_budget_lost_impression_share,
             metrics.search_rank_lost_impression_share
      FROM campaign
      WHERE campaign.id = ${bch.campaign_id} AND segments.date DURING LAST_30_DAYS`, 'budget_change_is_read')
    const m = mrows[0]?.metrics
    budgetLostIs = Number(m?.search_budget_lost_impression_share ?? 0)
    rankLostIs   = Number(m?.search_rank_lost_impression_share ?? 0)

    const diagnosis = diagnoseBudgetIncrease(budgetLostIs, rankLostIs)
    if (diagnosis === 'rank_dominant') {
      return {
        ok: false,
        summary: `Refused: lost impression share is rank-dominant (rank ${Math.round(rankLostIs * 100)}% vs budget ${Math.round(budgetLostIs * 100)}%) - budget is the wrong lever. Propose ads_change_bids instead.`,
        error:   'rank_dominant_is_loss',
      }
    }
    if (diagnosis === 'no_lost_is') {
      return {
        ok: false,
        summary: `Refused: budget-lost impression share is ${Math.round(budgetLostIs * 100)}% (floor ${BUDGET_LOST_IS_FLOOR * 100}%) - the campaign is not budget-constrained. Hold.`,
        error:   'not_budget_constrained',
      }
    }
  }

  const res = await client.mutate([buildBudgetUpdateOp(String(row.campaign_budget.resource_name), bch.new_daily_budget)],
    { approvalId: ctx.approvalId, label: 'change_budget' })
  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.campaign_budget_result?.resource_name)
    .filter((x): x is string => !!x)

  logger.info('ads_budget_change_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    campaignId: bch.campaign_id, previous: current, next: bch.new_daily_budget,
    isIncrease, budgetLostIs, rankLostIs,
  })
  const isPart = isIncrease
    ? ` (30-day IS lost to budget ${Math.round(budgetLostIs * 100)}%, to rank ${Math.round(rankLostIs * 100)}%)`
    : ''
  return {
    ok: true,
    summary: `Changed campaign ${bch.campaign_id} daily budget ${current} -> ${bch.new_daily_budget} via the Google Ads API.${isPart}`,
    detail: {
      campaign_id: bch.campaign_id, previous: current, next: bch.new_daily_budget,
      is_increase: isIncrease, budget_lost_is: budgetLostIs, rank_lost_is: rankLostIs,
      resource_names: resourceNames, rationale: bch.rationale ?? null,
    },
  }
}

// ── Chunk 1e: add positive keywords to an existing ad group ─────────────

export async function execAdsAddKeywords(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) return blockedNoApproval()

  const parsed = AddKeywordsInputSchema.safeParse(input)
  if (!parsed.success) return validationFailure('Add keywords', parsed.error)
  const ak = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  const agRows = await client.query(`
    SELECT ad_group.id, ad_group.status, campaign.bidding_strategy_type
    FROM ad_group
    WHERE ad_group.id = ${ak.ad_group_id} AND campaign.id = ${ak.campaign_id}`, 'add_keywords_preread')
  if (!agRows[0]?.ad_group?.id) {
    return { ok: false, summary: `Ad group ${ak.ad_group_id} not found on campaign ${ak.campaign_id}.`, error: 'ad_group_not_found' }
  }
  const strategy = enumName(enums.BiddingStrategyType, agRows[0].campaign?.bidding_strategy_type)

  // Idempotent re-approval: skip keywords already live on the ad group.
  const existing = new Set<string>()
  try {
    const rows = await client.query(`
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type
      FROM ad_group_criterion
      WHERE ad_group.id = ${ak.ad_group_id}
        AND ad_group_criterion.type = 'KEYWORD'
        AND ad_group_criterion.negative = FALSE
        AND ad_group_criterion.status != 'REMOVED'`, 'add_keywords_dedupe')
    for (const r of rows) {
      const kw = r.ad_group_criterion?.keyword
      if (kw?.text) existing.add(`${matchTypeName(kw.match_type)}:${kw.text.toLowerCase()}`)
    }
  } catch (err) {
    logger.warn('ads_add_keywords_dedupe_read_failed', {
      tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
      err: String(err).slice(0, 200),
      hint: 'Proceeding without dedupe; a true duplicate will surface as a permanent API error.',
    })
  }

  const proposed = dedupePositiveKeywords(ak.keywords)
  const shipped = proposed.filter((k) => !existing.has(`${k.match_type}:${k.text.toLowerCase()}`))
  const skipped = proposed.length - shipped.length

  if (shipped.length === 0) {
    return {
      ok: true,
      summary: `All ${proposed.length} proposed keyword(s) already exist on ad group ${ak.ad_group_id} - nothing to add.`,
      detail: {
        campaign_id: ak.campaign_id, ad_group_id: ak.ad_group_id,
        keywords: [], skipped_existing: skipped, resource_names: [], rationale: ak.rationale ?? null,
      },
    }
  }

  const ops = buildAddKeywordOps(client.customerId, ak, shipped)
  const res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'add_keywords' })
  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.ad_group_criterion_result?.resource_name)
    .filter((x): x is string => !!x)

  const cpcOnSmartBidding = shipped.some((k) => k.cpc != null) && strategy !== 'MANUAL_CPC'

  logger.info('ads_add_keywords_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    campaignId: ak.campaign_id, adGroupId: ak.ad_group_id,
    count: shipped.length, skipped, cpcOnSmartBidding,
  })
  const skippedPart = skipped ? ` (${skipped} already existed, skipped)` : ''
  const warnPart = cpcOnSmartBidding
    ? ` WARNING: campaign bidding strategy is ${strategy || 'not MANUAL_CPC'} - keyword CPC bids are stored but ignored under Smart Bidding.`
    : ''
  return {
    ok: true,
    summary: `Added ${shipped.length} keyword${shipped.length === 1 ? '' : 's'} to ad group ${ak.ad_group_id} via the Google Ads API.${skippedPart}${warnPart}`,
    detail: {
      campaign_id: ak.campaign_id, ad_group_id: ak.ad_group_id,
      keywords: shipped.map((k) => ({ text: k.text, match_type: k.match_type, cpc: k.cpc ?? null })),
      skipped_existing: skipped, cpc_on_smart_bidding: cpcOnSmartBidding,
      resource_names: resourceNames, rationale: ak.rationale ?? null,
    },
  }
}

// ── Chunk 1e: create ad group (PAUSED) ──────────────────────────────────

export async function execAdsCreateAdGroup(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) return blockedNoApproval()

  const parsed = CreateAdGroupInputSchema.safeParse(input)
  if (!parsed.success) return validationFailure('Create ad group', parsed.error)
  const cg = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  const cRows = await client.query(`
    SELECT campaign.id, campaign.status
    FROM campaign
    WHERE campaign.id = ${cg.campaign_id}`, 'create_ad_group_preread')
  if (!cRows[0]?.campaign?.id) {
    return { ok: false, summary: `Campaign ${cg.campaign_id} not found.`, error: 'campaign_not_found' }
  }
  if (enumName(enums.CampaignStatus, cRows[0].campaign.status) === 'REMOVED') {
    return { ok: false, summary: `Campaign ${cg.campaign_id} is removed.`, error: 'campaign_removed' }
  }

  // Idempotent re-approval: same-name ad group already on the campaign.
  const dupRows = await client.query(`
    SELECT ad_group.id
    FROM ad_group
    WHERE campaign.id = ${cg.campaign_id}
      AND ad_group.name = '${gaqlEscape(cg.name)}'
      AND ad_group.status != 'REMOVED'`, 'create_ad_group_dupe_check')
  if (dupRows[0]?.ad_group?.id) {
    return {
      ok: true,
      summary: `Ad group "${cg.name}" already exists on campaign ${cg.campaign_id} (id ${dupRows[0].ad_group.id}) - nothing to create.`,
      detail: { campaign_id: cg.campaign_id, existing_ad_group_id: Number(dupRows[0].ad_group.id), created: false },
    }
  }

  const ops = buildCreateAdGroupOps(client.customerId, cg)
  const res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'create_ad_group' })
  const adGroupResource = (res.mutate_operation_responses ?? [])
    .map((r) => r.ad_group_result?.resource_name)
    .filter((x): x is string => !!x)[0] ?? null
  const keywordResources = (res.mutate_operation_responses ?? [])
    .map((r) => r.ad_group_criterion_result?.resource_name)
    .filter((x): x is string => !!x)

  const kwCount = cg.keywords?.length ?? 0
  logger.info('ads_create_ad_group_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    campaignId: cg.campaign_id, name: cg.name, seedKeywords: kwCount,
  })
  return {
    ok: true,
    summary: `Created PAUSED ad group "${cg.name}" on campaign ${cg.campaign_id} with ${kwCount} seed keyword${kwCount === 1 ? '' : 's'} via the Google Ads API. Enabling it is the operator's action in the Google Ads UI.`,
    detail: {
      campaign_id: cg.campaign_id, name: cg.name, status: 'PAUSED',
      default_cpc: cg.default_cpc ?? null,
      seed_keywords: (cg.keywords ?? []).map((k) => ({ text: k.text, match_type: k.match_type, cpc: k.cpc ?? null })),
      ad_group_resource_name: adGroupResource, keyword_resource_names: keywordResources,
      rationale: cg.rationale ?? null,
    },
  }
}

// ── Chunk 1e: create campaign (PAUSED, SEARCH, AU + English) ────────────

export async function execAdsCreateCampaign(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) return blockedNoApproval()

  const parsed = CreateCampaignInputSchema.safeParse(input)
  if (!parsed.success) return validationFailure('Create campaign', parsed.error)
  const cc = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  // Idempotent re-approval: same-name campaign already on the account.
  const dupRows = await client.query(`
    SELECT campaign.id
    FROM campaign
    WHERE campaign.name = '${gaqlEscape(cc.name)}'
      AND campaign.status != 'REMOVED'`, 'create_campaign_dupe_check')
  if (dupRows[0]?.campaign?.id) {
    return {
      ok: true,
      summary: `Campaign "${cc.name}" already exists (id ${dupRows[0].campaign.id}) - nothing to create.`,
      detail: { existing_campaign_id: Number(dupRows[0].campaign.id), created: false },
    }
  }

  const ops = buildCreateCampaignOps(client.customerId, cc)
  const res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'create_campaign' })
  const campaignResource = (res.mutate_operation_responses ?? [])
    .map((r) => r.campaign_result?.resource_name)
    .filter((x): x is string => !!x)[0] ?? null
  const budgetResource = (res.mutate_operation_responses ?? [])
    .map((r) => r.campaign_budget_result?.resource_name)
    .filter((x): x is string => !!x)[0] ?? null

  logger.info('ads_create_campaign_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    name: cc.name, dailyBudget: cc.daily_budget, strategy: cc.bidding.strategy,
  })
  return {
    ok: true,
    summary: `Created PAUSED search campaign "${cc.name}" (daily budget ${cc.daily_budget}, ${cc.bidding.strategy}, AU geo + English) via the Google Ads API. Enabling it is the operator's action in the Google Ads UI.`,
    detail: {
      name: cc.name, status: 'PAUSED', daily_budget: cc.daily_budget,
      bidding: cc.bidding, geo: 'AU', language: 'en',
      campaign_resource_name: campaignResource, budget_resource_name: budgetResource,
      rationale: cc.rationale ?? null,
    },
  }
}

// ── Chunk 1e: replace RSA copy (create new + pause old, atomic) ─────────

export async function execAdsUpdateAdCopy(
  input: Record<string, unknown>,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  if (!ctx.approvalId) return blockedNoApproval()

  const parsed = AdCopyInputSchema.safeParse(input)
  if (!parsed.success) return validationFailure('Ad copy', parsed.error)
  const ac = parsed.data

  const client = await forTenant(ctx.tenant.tenantId)

  const agRows = await client.query(`
    SELECT ad_group.id, ad_group.status
    FROM ad_group
    WHERE ad_group.id = ${ac.ad_group_id} AND campaign.id = ${ac.campaign_id}`, 'ad_copy_preread')
  if (!agRows[0]?.ad_group?.id) {
    return { ok: false, summary: `Ad group ${ac.ad_group_id} not found on campaign ${ac.campaign_id}.`, error: 'ad_group_not_found' }
  }

  // Pause target may have changed between proposal and approval - skip
  // (with a note), don't fail: the new ad is still worth shipping.
  let pauseApplicable = false
  let pauseSkipReason: string | null = null
  if (ac.pause_ad_id != null) {
    const adRows = await client.query(`
      SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.ad.type
      FROM ad_group_ad
      WHERE ad_group.id = ${ac.ad_group_id}
        AND ad_group_ad.ad.id = ${ac.pause_ad_id}
        AND ad_group_ad.status != 'REMOVED'`, 'ad_copy_pause_preread')
    const ad = adRows[0]?.ad_group_ad
    if (!ad?.ad?.id) {
      pauseSkipReason = 'not_found_on_ad_group'
    } else if (enumName(enums.AdGroupAdStatus, ad.status) === 'PAUSED') {
      pauseSkipReason = 'already_paused'
    } else {
      pauseApplicable = true
    }
  }

  const ops = [buildCreateRsaOp(client.customerId, ac)]
  if (pauseApplicable && ac.pause_ad_id != null) {
    ops.push(buildPauseAdOp(client.customerId, ac.ad_group_id, ac.pause_ad_id))
  }
  const res = await client.mutate(ops, { approvalId: ctx.approvalId, label: 'update_ad_copy' })
  const resourceNames = (res.mutate_operation_responses ?? [])
    .map((r) => r.ad_group_ad_result?.resource_name)
    .filter((x): x is string => !!x)

  logger.info('ads_ad_copy_shipped', {
    tenantId: ctx.tenant.tenantId, approvalId: ctx.approvalId,
    campaignId: ac.campaign_id, adGroupId: ac.ad_group_id,
    headlines: ac.headlines.length, descriptions: ac.descriptions.length,
    pausedOldAd: pauseApplicable, pauseSkipReason,
  })
  const pausePart = ac.pause_ad_id == null
    ? ''
    : pauseApplicable
      ? ` Paused old ad ${ac.pause_ad_id} in the same request.`
      : ` Old ad ${ac.pause_ad_id} not paused (${pauseSkipReason}).`
  return {
    ok: true,
    summary: `Created new responsive search ad on ad group ${ac.ad_group_id} (${ac.headlines.length} headlines, ${ac.descriptions.length} descriptions) via the Google Ads API.${pausePart}`,
    detail: {
      campaign_id: ac.campaign_id, ad_group_id: ac.ad_group_id,
      headlines: ac.headlines, descriptions: ac.descriptions,
      final_url: ac.final_url, path1: ac.path1 ?? null, path2: ac.path2 ?? null,
      pause_ad_id: ac.pause_ad_id ?? null, paused_old_ad: pauseApplicable,
      pause_skip_reason: pauseSkipReason,
      resource_names: resourceNames, rationale: ac.rationale ?? null,
    },
  }
}
