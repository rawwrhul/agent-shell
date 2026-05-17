// src/core/opportunity-bank/card-builder.ts
//
// Every bank-surfaced opportunity gets an approval_requests row. The
// aggregator's anchor message renderer already queries approval_requests
// for this task and inlines them as Block Kit action buttons — so just
// creating the row is enough to make each opportunity actionable from
// Slack.
//
// Dispatch by opportunity type:
//
//   - Auto-execute types (AUTO_EXECUTE_TYPES) — agent can complete
//     without operator input. Today this list is empty for SEO domain.
//     Infrastructure here for future use.
//
//   - Manual types — produce an approval card with type-specific body.
//     Includes drafted email + mailto for outreach types; instruction
//     payload for audit-fix types.
//
// On approve, src/hitl/handlers.ts dispatches based on tool_name and
// runs the appropriate side effect (mark outreach as sent + cap check,
// flip opportunity to executed, etc).

import { Pool } from 'pg'
import { logger } from '../../logger'
import type { TenantConfig } from '../../tenants/types'
import { createApproval } from '../../hitl/state-store'
import { linkApprovalToOpportunity } from './transitions'
import type { Opportunity } from './types'

// ── Type classification ─────────────────────────────────────────────────

/** Types that the agent can complete autonomously, no card needed. */
export const AUTO_EXECUTE_TYPES: ReadonlySet<string> = new Set([
  // Empty for v1. When we add a type that's truly safe to auto-execute
  // (e.g. internal-only data refresh, recompute scoring, etc.), add it
  // here. Anything that touches client-visible content stays card-gated.
])

// ── Public API ──────────────────────────────────────────────────────────

export interface CreateApprovalCardsInput {
  pool:           Pool
  opportunities:  Opportunity[]
  taskId:         string
  tenant:         TenantConfig
}

export interface CardCreationResult {
  cardsCreated:        number
  autoExecuted:        number
  skippedUnsupported:  number
  errors:              string[]
}

/**
 * For each surfaced opportunity, either auto-execute or create an
 * approval_requests row with type-appropriate content. Idempotent at
 * the row level — linkApprovalToOpportunity uses ON CONFLICT semantics
 * via its WHERE clause.
 */
export async function createApprovalCardsForSurfaced(
  input: CreateApprovalCardsInput,
): Promise<CardCreationResult> {
  const result: CardCreationResult = {
    cardsCreated: 0, autoExecuted: 0, skippedUnsupported: 0, errors: [],
  }

  for (const opp of input.opportunities) {
    try {
      if (AUTO_EXECUTE_TYPES.has(opp.type)) {
        // Future: invoke the auto-execute dispatcher here. For v1 nothing
        // qualifies so we just log + skip card creation.
        logger.info('opportunity_auto_executed_skipping_card', {
          opportunityId: opp.id, type: opp.type,
        })
        result.autoExecuted++
        continue
      }

      const spec = buildCardSpec(opp, input.tenant)
      if (!spec) {
        logger.warn('opportunity_type_has_no_card_spec', {
          opportunityId: opp.id, type: opp.type,
        })
        result.skippedUnsupported++
        continue
      }

      const approval = await createApproval(input.pool, {
        tenantId:        input.tenant.tenantId,
        taskId:          input.taskId,
        toolName:        spec.toolName,
        toolInput:       spec.toolInput,
        riskLevel:       spec.riskLevel,
        riskReason:      spec.riskReason,
        priority:        opp.priority,
        proposedAction:  spec.proposedAction,
        whyPriority:     spec.whyPriority,
        previewUrl:      spec.previewUrl,
        slackChannelId:  input.tenant.slackChannelId,
      })

      await linkApprovalToOpportunity({
        approvalId:    approval.id,
        opportunityId: opp.id,
      })

      result.cardsCreated++
    } catch (err) {
      const msg = `${opp.type}/${opp.id}: ${String(err).slice(0, 200)}`
      logger.warn('approval_card_creation_failed', {
        opportunityId: opp.id, type: opp.type, err: String(err).slice(0, 300),
      })
      result.errors.push(msg)
    }
  }

  logger.info('approval_cards_created_for_surfaced', {
    tenantId:           input.tenant.tenantId,
    taskId:             input.taskId,
    cardsCreated:       result.cardsCreated,
    autoExecuted:       result.autoExecuted,
    skippedUnsupported: result.skippedUnsupported,
    errors:             result.errors.length,
  })
  return result
}

// ── Card spec dispatch ──────────────────────────────────────────────────

interface CardSpec {
  toolName:        string
  toolInput:       Record<string, unknown>
  riskLevel:       'low' | 'medium' | 'high'
  riskReason:      string
  proposedAction:  string
  whyPriority?:    string
  previewUrl?:     string
}

function buildCardSpec(opp: Opportunity, tenant: TenantConfig): CardSpec | null {
  const detail = (opp as Opportunity & { detail?: Record<string, unknown> }).detail ?? {}
  const operatorTag = formatOperatorTag(tenant)

  switch (opp.type) {
    // ── SEO-5 outreach types ────────────────────────────────────────────
    case 'pursue_backlink':
      return buildOutreachSpec({
        opp, detail, operatorTag,
        prospectKind: 'backlink_gap',
        leadIn: `Backlink prospect — DR ${detail.source_dr ?? '?'} referring domain`,
      })

    case 'fix_unlinked_mention':
      return buildOutreachSpec({
        opp, detail, operatorTag,
        prospectKind: 'unlinked_mention',
        leadIn: `Unlinked brand mention — warm prospect`,
      })

    // ── Audit-driven fix types ──────────────────────────────────────────
    case 'fix_duplicate_titles':
    case 'fix_duplicate_meta_descriptions':
    case 'fix_broken_internal_link':
    case 'fix_canonical_conflict':
    case 'fix_multiple_h1':
    case 'fix_missing_alt_text':
    case 'add_internal_link_to_orphan':
    case 'add_missing_meta_description':
    case 'add_missing_h1':
    case 'add_to_sitemap':
    case 'remove_from_sitemap':
      return buildAuditFixSpec({ opp, detail, operatorTag })

    // ── Content-creation types (handled by specialists via propose_action) ─
    case 'create_new_blog_post':
    case 'create_landing_page':
      // These come through propose_action in the specialist path — they
      // already get cards. If somehow filed directly to the bank, fall
      // through to generic manual ticket below.
      return buildGenericManualSpec({ opp, detail, operatorTag })

    // ── Anything else: generic manual ticket ────────────────────────────
    default:
      return buildGenericManualSpec({ opp, detail, operatorTag })
  }
}

// ── Outreach card spec ──────────────────────────────────────────────────

interface OutreachSpecInput {
  opp:           Opportunity
  detail:        Record<string, unknown>
  operatorTag:   string
  prospectKind:  'backlink_gap' | 'unlinked_mention'
  leadIn:        string
}

function buildOutreachSpec(input: OutreachSpecInput): CardSpec {
  const d = input.detail
  const sourceUrl  = str(d.source_url) ?? '(unknown)'
  const sourceDom  = str(d.source_domain) ?? str(d.source_url) ?? '(unknown)'
  const subject    = str(d.drafted_subject) ?? `Quick question about ${sourceDom}`
  const body       = str(d.drafted_body) ?? '(no draft generated — DataForSEO may have failed)'
  const mailtoUrl  = str(d.mailto_url) ?? null
  const queueId    = str(d.outreach_queue_id) ?? null
  const pitchAngle = str(d.pitch_angle) ?? null

  const whyPriority =
    `${input.leadIn}\n\n` +
    `*${input.operatorTag} — outreach approval needed.*\n\n` +
    `*Target:* ${sourceDom}\n` +
    (str(d.competitor_domain) ? `*They link to:* ${d.competitor_domain}\n` : '') +
    (str(d.anchor_text) ? `*Anchor text used:* "${d.anchor_text}"\n` : '') +
    `\n*Drafted subject:*\n${subject}\n\n` +
    `*Drafted body:*\n\`\`\`\n${body.slice(0, 1500)}\n\`\`\`\n\n` +
    (pitchAngle ? `_Why this pitch:_ ${pitchAngle}\n\n` : '') +
    `*Recipient email:* (paste into the Approvals Sheet next to this row)\n\n` +
    (mailtoUrl ? `*Mailto:* \`${mailtoUrl.slice(0, 500)}\`\n\n` : '') +
    `Approve = "I've sent this from my inbox" → marks the outreach as sent and runs the 20/day cap check.`

  return {
    toolName:       'outreach_send_mailto',
    toolInput:      {
      outreach_queue_id: queueId,
      target_site:       sourceDom,
      source_url:        sourceUrl,
      prospect_kind:     input.prospectKind,
      drafted_subject:   subject,
      drafted_body:      body,
      mailto_url:        mailtoUrl,
    },
    riskLevel:      'medium',
    riskReason:     whyPriority,
    proposedAction: `Send drafted outreach to ${sourceDom}`,
    whyPriority,
    previewUrl:     sourceUrl,
  }
}

// ── Audit fix card spec ─────────────────────────────────────────────────

interface AuditFixSpecInput {
  opp:         Opportunity
  detail:      Record<string, unknown>
  operatorTag: string
}

function buildAuditFixSpec(input: AuditFixSpecInput): CardSpec {
  const target = input.opp.target ?? '(no target page)'

  const whyPriority =
    `*${input.operatorTag} — manual fix needed in Framer.*\n\n` +
    `*Issue:* ${input.opp.description}\n\n` +
    (input.opp.rationale ? `*Why:* ${input.opp.rationale}\n\n` : '') +
    `*Target page:* ${target}\n\n` +
    `Approve = "I'll do this fix in Framer's UI."`

  return {
    toolName:       'manual_operator_task',
    toolInput:      {
      instruction:   `${input.opp.description}\n\nTarget: ${target}\n\n${input.opp.rationale ?? ''}`,
      category:      categoryFromType(input.opp.type),
      opportunity_id: input.opp.id,
    },
    riskLevel:      'low',
    riskReason:     whyPriority,
    proposedAction: `${input.opp.description}`,
    whyPriority,
    previewUrl:     target.startsWith('http') ? target : undefined,
  }
}

function categoryFromType(type: string): string {
  if (type.includes('link'))    return 'linking'
  if (type.includes('meta') || type.includes('title')) return 'meta'
  if (type.includes('schema'))  return 'schema'
  if (type.includes('canonical')) return 'canonical'
  if (type.includes('sitemap')) return 'sitemap'
  if (type.includes('h1') || type.includes('alt')) return 'on-page'
  return 'other'
}

// ── Generic manual card spec (fallback) ─────────────────────────────────

function buildGenericManualSpec(input: AuditFixSpecInput): CardSpec {
  return {
    toolName:       'manual_operator_task',
    toolInput:      {
      instruction:    `${input.opp.description}\n\nTarget: ${input.opp.target ?? '(none)'}\n\n${input.opp.rationale ?? ''}`,
      category:       'other',
      opportunity_id: input.opp.id,
    },
    riskLevel:      'low',
    riskReason:     `*${input.operatorTag}* — ${input.opp.description}\n\n${input.opp.rationale ?? ''}`,
    proposedAction: input.opp.description,
    whyPriority:    `Type: ${input.opp.type}`,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatOperatorTag(tenant: TenantConfig): string {
  const id = (tenant as TenantConfig & { operatorSlackUserId?: string }).operatorSlackUserId
  if (id && /^U[A-Z0-9]+$/.test(id)) return `<@${id}>`
  return 'Operator' // fallback when user ID not set
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}
