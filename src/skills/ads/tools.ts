// src/skills/ads/tools.ts
//
// Google Ads skill for specialists. Two tools:
//
//   propose_ads_action        - files a HITL approval for one of the nine
//                               registered ads_* executors. Validates the
//                               toolInput against the SAME zod schema the
//                               executor will use, at proposal time - the
//                               agent gets immediate feedback and the
//                               operator never sees a card that would fail
//                               validation on approve.
//   query_pending_ads_approvals - reads recent ads approvals so the agent
//                               does not double-file.
//
// Named propose_ads_action (not propose_action) so a tenant with both the
// seo and ads skills loaded gets no toolbelt name collision.
//
// Mirrors the seo skill's doProposeAction spine: createApproval is the
// authoritative write; the Slack card is best-effort; cron-fired runs
// suppress the individual card and surface via the anchor report.

import type Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { Pool } from 'pg'
import { config } from '../../config'
import { logger } from '../../logger'
import { createApproval } from '../../hitl/state-store'
import { getTenant } from '../../tenants/registry'
import { presenter } from '../../core/slack'
import { NegativeKeywordsInputSchema } from '../../integrations/googleads/negatives'
import { BidModifiersInputSchema } from '../../integrations/googleads/bid-modifiers'
import { KeywordEditsInputSchema } from '../../integrations/googleads/keyword-edits'
import { BidChangeInputSchema } from '../../integrations/googleads/bid-changes'
import { BudgetChangeInputSchema } from '../../integrations/googleads/budget-changes'
import { AddKeywordsInputSchema, CreateAdGroupInputSchema, CreateCampaignInputSchema } from '../../integrations/googleads/expansion'
import { AdCopyInputSchema } from '../../integrations/googleads/ad-copy'

let _pool: Pool | null = null
function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL, max: 3 })
  return _pool
}

export interface AdsToolContext {
  tenantId:       string
  runId:          string
  taskId:         string
  channelId?:     string
  triggerSource?: string
}

// toolName -> the exact schema its executor validates with. Proposal-time
// validation is the same gate as execution-time validation.
const ADS_ACTION_SCHEMAS: Record<string, z.ZodTypeAny> = {
  ads_add_negative_keywords: NegativeKeywordsInputSchema,
  ads_set_bid_modifiers:     BidModifiersInputSchema,
  ads_edit_keywords:         KeywordEditsInputSchema,
  ads_change_bids:           BidChangeInputSchema,
  ads_change_budget:         BudgetChangeInputSchema,
  ads_add_keywords:          AddKeywordsInputSchema,
  ads_create_ad_group:       CreateAdGroupInputSchema,
  ads_create_campaign:       CreateCampaignInputSchema,
  ads_update_ad_copy:        AdCopyInputSchema,
}

export const ADS_ACTION_TOOL_NAMES = Object.keys(ADS_ACTION_SCHEMAS)

export const WRITE_SIDE_ADS_TOOL_NAMES = new Set(['propose_ads_action'])

export const ADS_SKILL_TOOLS: Anthropic.Tool[] = [
  {
    name: 'propose_ads_action',
    description:
      "Create a HITL approval request for a Google Ads account change. Files the request - does NOT execute. " +
      "The executor runs only after operator approval. Every change goes through the official Google Ads API.\n\n" +
      "toolName MUST be ONE of these registered executors, with the exact toolInput contract:\n\n" +
      "  • ads_add_negative_keywords - block wasted spend on high-spend low-conversion search terms (mine them via google_ads_search_terms first). " +
      "toolInput = { scope: 'campaign'|'ad_group', campaign_id, ad_group_id? (required for ad_group scope), keywords: [{ text, match_type: 'EXACT'|'PHRASE'|'BROAD' }] (max 20), rationale? }.\n\n" +
      "  • ads_set_bid_modifiers - device bid modifiers on an ad group. " +
      "toolInput = { campaign_id, ad_group_id, modifiers: [{ device: 'MOBILE'|'DESKTOP'|'TABLET', modifier: 0.1-10.0 }], rationale? }. " +
      "Modifier 0 (device opt-out) is not allowed here - propose manual_operator_task via the seo skill or flag it in your report.\n\n" +
      "  • ads_edit_keywords - pause/enable/set CPC on EXISTING positive keywords. " +
      "toolInput = { campaign_id, ad_group_id, edits: [{ criterion_id, action: 'pause'|'enable'|'set_cpc', cpc? (required for set_cpc, 0.05-200) }] (max 20), rationale? }. " +
      "Keyword text and match type are immutable - to replace a keyword, pause it here and add the new one via ads_add_keywords.\n\n" +
      "  • ads_change_bids - move a bidding target. " +
      "toolInput = { field: 'target_cpa', campaign_id, new_target (0.5-10000) } OR { field: 'target_roas', campaign_id, new_target (0.1-100) } OR { field: 'ad_group_cpc', campaign_id, ad_group_id, new_cpc (0.05-200) }, plus rationale?. " +
      "Direction rules: raise tCPA = more aggressive. LOWER tROAS = more aggressive (inverse). ad_group_cpc only works on MANUAL_CPC campaigns. " +
      "Max 30% relative step per approval - larger moves need multiple approvals over days. " +
      "Campaigns on targetless Max Conversions/Max Conversion Value have no target to move: route aggression to ads_change_budget instead.\n\n" +
      "  • ads_change_budget - change a campaign's daily budget. " +
      "toolInput = { campaign_id, new_daily_budget (1-10000), rationale? }. Max 50% relative step. " +
      "DIAGNOSE FIRST via google_ads_campaign_overview: increases are only accepted when impression share lost to BUDGET is at least 5%. " +
      "If lost IS is rank-dominant the executor refuses (wrong lever - propose ads_change_bids). If both are near zero it refuses (hold). Decreases are always allowed within bounds.\n\n" +
      "  • ads_add_keywords - add positive keywords to an EXISTING ad group (expansion on proven performers). " +
      "toolInput = { campaign_id, ad_group_id, keywords: [{ text, match_type, cpc? }] (max 30), rationale? }.\n\n" +
      "  • ads_create_ad_group - new ad group in an existing campaign, created PAUSED. " +
      "toolInput = { campaign_id, name, keywords? (seed positives), default_cpc?, rationale? }. Enabling is the operator's action in the Google Ads UI, never yours.\n\n" +
      "  • ads_create_campaign - new SEARCH campaign, created PAUSED, AU geo + English targeting. " +
      "toolInput = { name, daily_budget (max 1000), bidding: { strategy: 'MANUAL_CPC' } | { strategy: 'MAXIMIZE_CONVERSIONS', target_cpa? }, rationale? }. Enabling is the operator's action.\n\n" +
      "  • ads_update_ad_copy - replace a responsive search ad's copy (RSAs are immutable: this creates a NEW ad and optionally pauses the old one atomically). " +
      "toolInput = { campaign_id, ad_group_id, headlines: [3-15 strings, each <=30 chars], descriptions: [2-4 strings, each <=90 chars], final_url (https), path1?, path2? (path2 requires path1), pause_ad_id?, rationale? }. " +
      "Source angles and value props from SERP research - never copy competitor text literally.\n\n" +
      "toolInput is validated against the executor's own schema at filing time - a validation error means fix the input and re-file, not work around it. " +
      "ALWAYS read current account state (google_ads_campaign_overview, google_ads_search_terms, google_ads_keywords, google_ads_ads) before proposing, and cite the numbers in whyPriority.",
    input_schema: {
      type: 'object',
      properties: {
        toolName:       { type: 'string', enum: ADS_ACTION_TOOL_NAMES },
        toolInput:      { type: 'object' },
        proposedAction: { type: 'string', description: 'One-line plain-English summary the operator sees on the card' },
        detail:         { type: 'array', items: { type: 'string' } },
        whyPriority:    { type: 'string', description: 'The data-grounded rationale - cite spend, conversions, IS numbers from the read tools' },
        priority:       { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        riskLevel:      { type: 'string', enum: ['low', 'medium', 'high'] },
      },
      required: ['toolName', 'toolInput', 'proposedAction', 'priority'],
    },
  },
  {
    name: 'query_pending_ads_approvals',
    description:
      'List recent Google Ads approval requests for this tenant (pending and resolved, newest first). ' +
      'Call this BEFORE filing proposals to avoid duplicating an approval the operator already has in their queue or already rejected.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max rows (default 20)' },
      },
    },
  },
]

const SKILL_TOOL_NAMES = new Set(ADS_SKILL_TOOLS.map((t) => t.name))

export function isAdsSkillToolName(name: string): boolean {
  return SKILL_TOOL_NAMES.has(name)
}

export async function executeAdsSkillTool(
  name:  string,
  input: Record<string, unknown>,
  ctx:   AdsToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'propose_ads_action':          return await doProposeAdsAction(input, ctx)
      case 'query_pending_ads_approvals': return await doQueryAdsApprovals(input, ctx)
      default: return `Unknown ads skill tool: ${name}`
    }
  } catch (err) {
    logger.warn('ads_skill_tool_failed', { tenantId: ctx.tenantId, tool: name, err: String(err).slice(0, 300) })
    return `${name} failed: ${String(err).slice(0, 300)}`
  }
}

async function doProposeAdsAction(input: Record<string, unknown>, ctx: AdsToolContext): Promise<string> {
  const i = input as {
    toolName: string
    toolInput: Record<string, unknown>
    proposedAction: string
    detail?: string[]
    whyPriority?: string
    priority: 'P0' | 'P1' | 'P2' | 'P3'
    riskLevel?: 'low' | 'medium' | 'high'
  }

  const schema = ADS_ACTION_SCHEMAS[i.toolName]
  if (!schema) {
    return `ADS_PROPOSAL_REJECTED: toolName "${i.toolName}" is not a registered ads executor. Valid values: ${ADS_ACTION_TOOL_NAMES.join(', ')}.`
  }

  // Proposal-time validation with the executor's own schema. Same gate the
  // execution path applies - failing here saves the operator from approving
  // a card that would immediately fail.
  const parsed = schema.safeParse(i.toolInput ?? {})
  if (!parsed.success) {
    const issues = parsed.error.issues.map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')
    logger.warn('ads_proposal_validation_failed', {
      tenantId: ctx.tenantId, taskId: ctx.taskId, toolName: i.toolName, issues: issues.slice(0, 400),
    })
    return `ADS_PROPOSAL_VALIDATION_FAILED for ${i.toolName}: ${issues}\n\nFix toolInput to satisfy the contract and call propose_ads_action again.`
  }

  let tenant: Awaited<ReturnType<typeof getTenant>> | null = null
  try { tenant = await getTenant(ctx.tenantId) } catch { /* fall through with null */ }
  const effectiveChannelId = ctx.channelId ?? tenant?.slackChannelId ?? null

  const approval = await createApproval(pool(), {
    tenantId:       ctx.tenantId,
    taskId:         ctx.taskId,
    toolName:       i.toolName,
    toolInput:      parsed.data as Record<string, unknown>,
    riskLevel:      i.riskLevel ?? 'medium',
    riskReason:     i.whyPriority ?? `Proposed via ads skill, priority ${i.priority}.`,
    priority:       i.priority,
    proposedAction: i.proposedAction,
    detail:         i.detail ?? [],
    whyPriority:    i.whyPriority,
    slackChannelId: effectiveChannelId ?? undefined,
  })

  const isCronFired = !!ctx.triggerSource && ctx.triggerSource.startsWith('cron-')
  if (effectiveChannelId && !isCronFired) {
    try {
      await presenter.requestApproval({
        tenantId:   ctx.tenantId,
        channelId:  effectiveChannelId,
        taskId:     ctx.taskId,
        toolName:   i.toolName,
        riskLevel:  approval.riskLevel,
        riskReason: i.whyPriority ?? `Priority ${i.priority}.`,
        approvalId: approval.id,
        tenantName: tenant?.clientName,
        summary:    i.proposedAction,
      })
    } catch (err) {
      logger.warn('ads_approval_slack_post_failed', {
        tenantId: ctx.tenantId, approvalId: approval.id, err: String(err).slice(0, 200),
      })
    }
  } else if (isCronFired) {
    logger.info('ads_approval_cron_batched', {
      tenantId: ctx.tenantId, approvalId: approval.id, trigger: ctx.triggerSource,
      hint: 'Cron-fired run; approval will surface in the final anchor report rather than as an individual card.',
    })
  }

  return `Approval ${approval.id.slice(0, 8)} filed for ${i.toolName} (${approval.priority}, risk ${approval.riskLevel}).`
}

async function doQueryAdsApprovals(input: Record<string, unknown>, ctx: AdsToolContext): Promise<string> {
  const limitRaw = Math.floor(Number((input as { limit?: unknown }).limit))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20

  const { rows } = await pool().query<{
    id: string; tool_name: string; status: string; priority: string
    proposed_action: string | null; executed_outcome: string | null; created_at: Date
  }>(
    `SELECT id, tool_name, status, priority, proposed_action, executed_outcome, created_at
     FROM approval_requests
     WHERE tenant_id = $1 AND tool_name LIKE 'ads\\_%'
     ORDER BY created_at DESC
     LIMIT $2`,
    [ctx.tenantId, limit],
  )
  if (rows.length === 0) return 'No Google Ads approvals on record for this tenant.'
  return rows.map((r) => {
    const outcome = r.executed_outcome ? ` | outcome: ${r.executed_outcome.slice(0, 120)}` : ''
    return `[${r.status}/${r.priority}] ${r.tool_name} - ${r.proposed_action ?? '(no summary)'} (${r.created_at.toISOString().slice(0, 10)})${outcome}`
  }).join('\n')
}
