// src/skills/seo/tools.ts
//
// SEO tool definitions and execution. Specialists with the 'seo' skill
// get these tools added to their toolbelt by buildToolsForSpecialist.
//
// Write-side tools (propose_action, log_seo_action, log_opportunity,
// snapshot_metrics, upsert_cluster) are stripped in investigate mode.
//
// propose_action is the gateway for all operator-visible changes.
// It writes to approval_requests and posts a "Needs your call" Slack card
// so the operator can approve or reject before anything touches external systems.

import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import { pool } from '../../memory/postgres'
import { postBlocksToSlack } from '../../core/slack/index'
import {
  buildProposalCard,
  buildProposalFallbackText,
} from '../../core/slack/blocks/proposal-card'
import type { ApprovalCardData, RiskLevel } from '../../core/slack/blocks/types'
import { getTenant } from '../../tenants/registry'
import { logger } from '../../logger'

// ── Context type ──────────────────────────────────────────────────────────

export interface SeoToolContext {
  tenantId:   string
  taskId:     string
  runId:      string
  channelId?: string
}

// ── Tool definitions ──────────────────────────────────────────────────────

export const SEO_TOOLS: Anthropic.Tool[] = [
  // ── Write-side: requires propose_changes intent ────────────────────────

  {
    name: 'propose_action',
    description: `Propose an action for the operator to review in Slack. The operator sees a card with Approve / Reject buttons. If approved, the executor worker calls the specified integration tool. Use this for ANY change to the client's website or external accounts.

IMPORTANT: Read the relevant page or data with integration tools BEFORE proposing a change. Do not propose "fix the homepage title" without first reading the current title.

WRONG: propose_action before checking the current state.
RIGHT: analyze_page(url) → see current state → propose_action with a specific, verified change.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        toolName: {
          type: 'string',
          description: 'The integration tool the executor should call if approved (e.g. "framer_update_page", "gsc_submit_url"). Must be a real tool name the executor recognises.',
        },
        toolInput: {
          type: 'object' as const,
          description: 'Arguments to pass to toolName on execution. Must be a complete, valid input for that tool.',
          properties: {},
          additionalProperties: true,
        },
        proposedAction: {
          type: 'string',
          description: 'Plain-language description of what will happen if approved. No jargon — write for the operator. e.g. "Trim the homepage title from 87 to 52 characters so it stops being cut off in search results."',
        },
        whyPriority: {
          type: 'string',
          description: 'Why this matters now, in one sentence in operator language. e.g. "The title is currently being cut off in search results, which reduces how often people click through to your site."',
        },
        riskLevel: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Risk of the proposed action. low=reversible in minutes, medium=reversible in hours, high=hard to reverse (e.g. URL changes), critical=irreversible.',
        },
      },
      required: ['toolName', 'toolInput', 'proposedAction', 'whyPriority', 'riskLevel'],
    },
  },

  {
    name: 'log_seo_action',
    description: 'Record a completed SEO action in the work log. Call this AFTER an approved action has been executed by the executor worker — not before, and not for proposed-but-not-yet-approved actions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        actionType: {
          type: 'string',
          description: 'Short category label (e.g. "title_update", "redirect_added", "schema_added", "content_updated").',
        },
        summary: {
          type: 'string',
          description: 'One sentence: what was done, in plain language.',
        },
        url: {
          type: 'string',
          description: 'The page or resource URL this action affected.',
        },
        status: {
          type: 'string',
          enum: ['success', 'partial', 'failed'],
          description: 'Outcome of the action.',
        },
        metadata: {
          type: 'object' as const,
          description: 'Optional structured details (before/after values, error info, etc.).',
          properties: {},
          additionalProperties: true,
        },
      },
      required: ['actionType', 'summary', 'status'],
    },
  },

  {
    name: 'log_opportunity',
    description: 'Surface a finding worth acting on later — something the operator should do but that wasn\'t part of the current task scope. These appear in the daily/weekly report as "backlog" items.',
    input_schema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description: 'The opportunity in plain language. Lead with the action and impact. e.g. "Adding a FAQ section to the /services page could improve how often Google shows your page in search results."',
        },
        priority: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3'],
          description: 'P0=urgent/critical, P1=high impact/do this week, P2=medium term, P3=backlog',
        },
        url: {
          type: 'string',
          description: 'The relevant page URL, if applicable.',
        },
        estimatedEffort: {
          type: 'string',
          description: 'Rough effort estimate in operator terms (e.g. "30 minutes", "one afternoon").',
        },
      },
      required: ['description', 'priority'],
    },
  },

  {
    name: 'snapshot_metrics',
    description: 'Record a point-in-time metric snapshot for the tenant. Used for weekly trend reporting. Call after measuring a metric via integration tools.',
    input_schema: {
      type: 'object' as const,
      properties: {
        indexedPages:          { type: 'number', description: 'Number of pages showing in Google.' },
        rankingKeywords:       { type: 'number', description: 'Number of keywords the site ranks for.' },
        schemaCoveragePct:     { type: 'number', description: 'Percentage of key pages with schema markup.' },
        avgPosition:           { type: 'number', description: 'Average position in search results (lower is better).' },
        aiCitationsEstimated:  { type: 'number', description: 'Estimated citations in AI-generated answers.' },
        domainRating:          { type: 'number', description: 'Domain authority score (0-100).' },
        notes:                 { type: 'string', description: 'Optional context about this snapshot.' },
      },
      required: [],
    },
  },

  {
    name: 'upsert_cluster',
    description: 'Create or update a topical content cluster record. Tracks the state of a planned content cluster (pillar topic + supporting pages).',
    input_schema: {
      type: 'object' as const,
      properties: {
        pillarTopic: {
          type: 'string',
          description: 'The main topic this cluster covers (e.g. "offshore recruitment", "remote team management").',
        },
        state: {
          type: 'string',
          enum: ['planned', 'in_progress', 'complete'],
          description: 'Current state of the cluster.',
        },
        briefsLanded: {
          type: 'number',
          description: 'Number of content briefs/pages published for this cluster.',
        },
        briefsTotal: {
          type: 'number',
          description: 'Total planned pages for this cluster.',
        },
        awaitingPublish: {
          type: 'number',
          description: 'Pages written but not yet published.',
        },
        detail: {
          type: 'string',
          description: 'Optional one-line status note.',
        },
      },
      required: ['pillarTopic', 'state'],
    },
  },

  // ── Read-side: available in both investigate and propose_changes ────────

  {
    name: 'query_opportunities',
    description: 'Query the backlog of surfaced opportunities for this tenant. Useful for understanding what\'s already been flagged before proposing new actions.',
    input_schema: {
      type: 'object' as const,
      properties: {
        priority: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3'],
          description: 'Filter by priority. Omit to get all.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 20).',
        },
      },
      required: [],
    },
  },

  {
    name: 'query_work_log',
    description: 'Query the SEO work log — what actions have been completed for this tenant. Useful for understanding recent activity before planning new work.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 20).',
        },
        sinceHours: {
          type: 'number',
          description: 'Only return entries from the last N hours.',
        },
      },
      required: [],
    },
  },

  {
    name: 'query_pending_approvals',
    description: 'Query pending approval requests for this tenant. Use to check what\'s already been proposed and is awaiting operator review, so you don\'t duplicate proposals.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10).',
        },
      },
      required: [],
    },
  },
]

const SEO_TOOL_NAMES = new Set(SEO_TOOLS.map(t => t.name))

export function isSeoToolName(name: string): boolean {
  return SEO_TOOL_NAMES.has(name)
}

// ── Execution ─────────────────────────────────────────────────────────────

export async function executeSeoTool(
  name: string,
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'propose_action':        return executeProposeAction(input, ctx)
      case 'log_seo_action':        return executeLogSeoAction(input, ctx)
      case 'log_opportunity':       return executeLogOpportunity(input, ctx)
      case 'snapshot_metrics':      return executeSnapshotMetrics(input, ctx)
      case 'upsert_cluster':        return executeUpsertCluster(input, ctx)
      case 'query_opportunities':   return executeQueryOpportunities(input, ctx)
      case 'query_work_log':        return executeQueryWorkLog(input, ctx)
      case 'query_pending_approvals': return executeQueryPendingApprovals(input, ctx)
      default:                      return `Unknown SEO tool: ${name}`
    }
  } catch (err) {
    logger.error('seo_tool_failed', { name, tenantId: ctx.tenantId, err: String(err).slice(0, 300) })
    return `SEO tool error (${name}): ${String(err).slice(0, 200)}`
  }
}

// ── propose_action ────────────────────────────────────────────────────────

async function executeProposeAction(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const toolName      = String(input.toolName ?? '')
  const toolInput     = (input.toolInput ?? {}) as Record<string, unknown>
  const proposedAction = String(input.proposedAction ?? '')
  const whyPriority   = String(input.whyPriority ?? '')
  const riskLevel     = (['low', 'medium', 'high', 'critical'].includes(String(input.riskLevel))
    ? String(input.riskLevel)
    : 'medium') as RiskLevel

  if (!toolName || !proposedAction || !whyPriority) {
    return 'propose_action: toolName, proposedAction, and whyPriority are required'
  }

  const id = uuid()
  const now = new Date()

  // Write to approval_requests
  await pool.query(
    `INSERT INTO approval_requests
       (id, tenant_id, task_id, session_id, tool_name, tool_input,
        risk_level, risk_reason, status, requested_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)`,
    [
      id,
      ctx.tenantId,
      ctx.taskId,
      ctx.runId,
      toolName,
      JSON.stringify({ toolName, toolInput, proposedAction, whyPriority }),
      riskLevel,
      whyPriority,
      now,
    ],
  )

  logger.info('approval_request_created', {
    id, tenantId: ctx.tenantId, taskId: ctx.taskId, toolName, riskLevel,
  })

  // Post Slack card if we have a channel
  const channelId = ctx.channelId
  if (channelId) {
    try {
      const cardData: ApprovalCardData = {
        approvalId:     id,
        toolName,
        proposedAction,
        whyPriority,
        riskLevel,
        requestedAt:    now,
        specialistType: ctx.runId, // best proxy available in tool context
      }

      const blocks      = buildProposalCard(cardData)
      const fallback    = buildProposalFallbackText(cardData)
      const messageTs   = await postBlocksToSlack(ctx.tenantId, channelId, blocks, fallback)

      // Store the message timestamp so we can update the card on resolution
      if (messageTs) {
        await pool.query(
          `UPDATE approval_requests
           SET slack_message_ts=$1, slack_channel_id=$2
           WHERE id=$3`,
          [messageTs, channelId, id],
        )
      }
    } catch (err) {
      // Slack card posting is best-effort — don't fail the tool call
      logger.warn('propose_action_slack_card_failed', {
        id, tenantId: ctx.tenantId, err: String(err).slice(0, 200),
      })
    }
  }

  return `Approval request created (id: ${id}). The operator will be notified in Slack to review: "${proposedAction}". The change will only happen if they approve it.`
}

// ── log_seo_action ────────────────────────────────────────────────────────

async function executeLogSeoAction(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const id         = uuid()
  const actionType = String(input.actionType ?? '')
  const summary    = String(input.summary ?? '')
  const url        = String(input.url ?? '')
  const status     = String(input.status ?? 'success')
  const metadata   = (input.metadata ?? {}) as Record<string, unknown>

  await pool.query(
    `INSERT INTO seo_work_log
       (id, tenant_id, run_id, action_type, summary, url, status, metadata, executed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
    [id, ctx.tenantId, ctx.runId, actionType, summary, url || null, status, JSON.stringify(metadata)],
  )

  logger.info('seo_action_logged', { id, tenantId: ctx.tenantId, actionType, status })
  return `Action logged (id: ${id.slice(0, 8)}, type: ${actionType}, status: ${status})`
}

// ── log_opportunity ───────────────────────────────────────────────────────

async function executeLogOpportunity(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const id               = uuid()
  const description      = String(input.description ?? '')
  const priority         = String(input.priority ?? 'P2')
  const url              = String(input.url ?? '')
  const estimatedEffort  = String(input.estimatedEffort ?? '')

  await pool.query(
    `INSERT INTO seo_opportunities
       (id, tenant_id, run_id, description, priority, url, estimated_effort, status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'open',NOW())`,
    [id, ctx.tenantId, ctx.runId, description, priority, url || null, estimatedEffort || null],
  )

  logger.info('seo_opportunity_logged', { id, tenantId: ctx.tenantId, priority })
  return `Opportunity recorded (id: ${id.slice(0, 8)}, priority: ${priority})`
}

// ── snapshot_metrics ──────────────────────────────────────────────────────

async function executeSnapshotMetrics(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const id = uuid()
  await pool.query(
    `INSERT INTO seo_metrics_snapshots
       (id, tenant_id, indexed_pages, ranking_keywords, schema_coverage_pct,
        avg_position, ai_citations_estimated, domain_rating, notes, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
    [
      id, ctx.tenantId,
      numOrNull(input.indexedPages),
      numOrNull(input.rankingKeywords),
      numOrNull(input.schemaCoveragePct),
      numOrNull(input.avgPosition),
      numOrNull(input.aiCitationsEstimated),
      numOrNull(input.domainRating),
      input.notes ? String(input.notes) : null,
    ],
  )

  logger.info('seo_metrics_snapshotted', { id, tenantId: ctx.tenantId })
  return `Metrics snapshot recorded (id: ${id.slice(0, 8)})`
}

// ── upsert_cluster ────────────────────────────────────────────────────────

async function executeUpsertCluster(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const pillarTopic     = String(input.pillarTopic ?? '')
  const state           = String(input.state ?? 'planned')
  const briefsLanded    = numOrNull(input.briefsLanded) ?? 0
  const briefsTotal     = numOrNull(input.briefsTotal) ?? 0
  const awaitingPublish = numOrNull(input.awaitingPublish) ?? 0
  const detail          = input.detail ? String(input.detail) : null

  await pool.query(
    `INSERT INTO seo_clusters
       (id, tenant_id, pillar_topic, state, briefs_landed, briefs_total,
        awaiting_publish, detail, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
     ON CONFLICT (tenant_id, pillar_topic)
     DO UPDATE SET
       state=$4, briefs_landed=$5, briefs_total=$6,
       awaiting_publish=$7, detail=$8, updated_at=NOW()`,
    [uuid(), ctx.tenantId, pillarTopic, state, briefsLanded, briefsTotal, awaitingPublish, detail],
  )

  logger.info('seo_cluster_upserted', { tenantId: ctx.tenantId, pillarTopic, state })
  return `Cluster "${pillarTopic}" updated (state: ${state}, ${briefsLanded}/${briefsTotal} briefs)`
}

// ── query tools ──────────────────────────────────────────────────────────

async function executeQueryOpportunities(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const priority = input.priority ? String(input.priority) : null
  const limit    = Math.min(Number(input.limit ?? 20), 50)

  const res = await pool.query<{
    id: string; description: string; priority: string; url: string | null; status: string; created_at: Date
  }>(
    `SELECT id, description, priority, url, status, created_at
     FROM seo_opportunities
     WHERE tenant_id=$1 AND ($2::text IS NULL OR priority=$2)
     ORDER BY priority ASC, created_at DESC
     LIMIT $3`,
    [ctx.tenantId, priority, limit],
  )

  if (!res.rows.length) return 'No opportunities found.'
  return res.rows.map(r =>
    `[${r.priority}] ${r.description}${r.url ? ` (${r.url})` : ''} — ${r.status}`
  ).join('\n')
}

async function executeQueryWorkLog(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const limit      = Math.min(Number(input.limit ?? 20), 50)
  const sinceHours = input.sinceHours ? Number(input.sinceHours) : null

  const res = await pool.query<{
    id: string; action_type: string; summary: string; status: string; executed_at: Date
  }>(
    `SELECT id, action_type, summary, status, executed_at
     FROM seo_work_log
     WHERE tenant_id=$1
       AND ($2::interval IS NULL OR executed_at >= NOW() - $2::interval)
     ORDER BY executed_at DESC
     LIMIT $3`,
    [ctx.tenantId, sinceHours ? `${sinceHours} hours` : null, limit],
  )

  if (!res.rows.length) return 'No work log entries found.'
  return res.rows.map(r =>
    `[${r.status}] ${r.action_type}: ${r.summary} (${r.executed_at.toISOString().slice(0, 10)})`
  ).join('\n')
}

async function executeQueryPendingApprovals(
  input: Record<string, unknown>,
  ctx: SeoToolContext,
): Promise<string> {
  const limit = Math.min(Number(input.limit ?? 10), 25)

  const res = await pool.query<{
    id: string; tool_name: string; tool_input: Record<string, unknown>; risk_level: string; requested_at: Date
  }>(
    `SELECT id, tool_name, tool_input, risk_level, requested_at
     FROM approval_requests
     WHERE tenant_id=$1 AND status='pending'
     ORDER BY requested_at DESC
     LIMIT $2`,
    [ctx.tenantId, limit],
  )

  if (!res.rows.length) return 'No pending approvals.'
  return res.rows.map(r => {
    const pa = r.tool_input?.proposedAction
    const desc = typeof pa === 'string' ? pa : r.tool_name
    return `[${r.risk_level}] ${desc} — pending since ${r.requested_at.toISOString().slice(0, 16)}`
  }).join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

// getTenant is imported for future use by tool handlers that need tenant config
void getTenant
