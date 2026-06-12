// src/core/opportunity-bank/reshape.ts
//
// Reshape-on-feedback. When an operator rejects an approval with a
// substantive reason, generate a new opportunity variant that incorporates
// the feedback. Flat rejections ("no", "never", "stop") are treated as
// terminal — no descendant generated.
//
// Lineage safety: reshape_count caps at RESHAPE_MAX_DEPTH (default 3).
// Past that, all rejections on the lineage are terminal.

import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import { pool } from '../../memory/postgres'
import { config } from '../../config'
import { logger } from '../../logger'
import { callAnthropic } from '../../lib/anthropic-call'
import {
  FLAT_REJECTION_KEYWORDS, FLAT_REJECTION_MAX_LENGTH,
  RESHAPE_MAX_DEPTH,
} from './types'
import { markRejected, linkReshapeDescendant, getOpportunityForApproval } from './transitions'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
const RESHAPE_MODEL = 'claude-sonnet-4-5-20250929'

/**
 * Decide whether a rejection reason is "flat" (terminal — no reshape) or
 * "substantive" (worth a reshape attempt).
 *
 * Rules:
 *   - null / empty / whitespace-only → flat
 *   - short AND matches a dismissive keyword → flat
 *   - anything else → substantive
 */
export function isFlatRejection(reason: string | null): boolean {
  if (!reason) return true
  const trimmed = reason.trim()
  if (trimmed.length === 0) return true

  if (trimmed.length <= FLAT_REJECTION_MAX_LENGTH) {
    const lower = trimmed.toLowerCase()
    for (const kw of FLAT_REJECTION_KEYWORDS) {
      if (lower === kw || lower.includes(kw)) return true
    }
  }
  return false
}

/**
 * Top-level rejection handler hook. Called from the HITL reject path with
 * the approval ID and rejection reason. Looks up the linked opportunity,
 * decides flat vs substantive, and either marks rejected or reshapes.
 *
 * Best-effort: any failure here is logged but never thrown. The HITL
 * approval itself has already been resolved as rejected upstream — this
 * function only updates the opportunity-bank side of the world.
 */
export async function handleRejectionOnOpportunity(input: {
  approvalId:      string
  rejectionReason: string | null
}): Promise<void> {
  try {
    const opp = await getOpportunityForApproval(input.approvalId)
    if (!opp) {
      // Approval wasn't bank-linked — nothing to do here.
      return
    }

    if (opp.status === 'rejected') {
      // Already handled (idempotent).
      return
    }

    const flat = isFlatRejection(input.rejectionReason)
    const overDepth = opp.reshapeCount >= RESHAPE_MAX_DEPTH

    if (flat || overDepth) {
      await markRejected({
        opportunityId: opp.id,
        reason:        input.rejectionReason,
      })
      logger.info('opportunity_rejected_terminal', {
        opportunityId: opp.id,
        reason:        flat ? 'flat_rejection' : 'reshape_depth_cap',
        reshapeCount:  opp.reshapeCount,
      })
      return
    }

    // Substantive feedback → reshape.
    const descendant = await reshapeOpportunity({
      sourceOpportunity: opp,
      rejectionReason:   input.rejectionReason ?? '',
    })

    if (!descendant) {
      // Reshape LLM failed or produced nothing usable — just mark rejected.
      await markRejected({
        opportunityId: opp.id,
        reason:        input.rejectionReason,
      })
      logger.warn('opportunity_reshape_failed_falling_back_to_reject', {
        opportunityId: opp.id,
      })
      return
    }

    // Mark original rejected, link the descendant.
    await markRejected({ opportunityId: opp.id, reason: input.rejectionReason })
    await linkReshapeDescendant({
      sourceId:     opp.id,
      descendantId: descendant.id,
    })
    logger.info('opportunity_reshaped', {
      sourceId:      opp.id,
      descendantId:  descendant.id,
      newReshapeCount: opp.reshapeCount + 1,
    })
  } catch (err) {
    logger.warn('handle_rejection_on_opportunity_threw', {
      approvalId: input.approvalId,
      err:        String(err).slice(0, 300),
    })
  }
}

// ── Reshape LLM ─────────────────────────────────────────────────────────

interface ReshapeInputOpp {
  id:            string
  tenantId:      string
  type:          string
  target:        string | null
  description:   string
  rationale:     string | null
  priority:      string
  reshapeCount:  number
}

interface ReshapeDescendant {
  id: string
}

/**
 * Generate a reshape descendant from an opportunity + rejection reason.
 * The LLM is asked to keep type stable and adjust target/description/
 * rationale based on the feedback. Returns the new opportunity's ID,
 * or null if the LLM produced nothing usable.
 */
export async function reshapeOpportunity(input: {
  sourceOpportunity: ReshapeInputOpp
  rejectionReason:   string
}): Promise<ReshapeDescendant | null> {
  const src = input.sourceOpportunity
  const prompt = `An opportunity for a tenant was rejected by the operator. Use the rejection reason to propose a refined version. Keep the same opportunity type. Adjust target, description, and rationale to address the feedback. Do not invent unrelated angles.

Original opportunity:
- type:        ${src.type}
- target:      ${src.target ?? '(none)'}
- priority:    ${src.priority}
- description: ${src.description}
- rationale:   ${src.rationale ?? '(none)'}

Operator's rejection reason:
${input.rejectionReason}

Return ONLY a JSON object, no preamble:

{
  "target":      "<new exemplar URL or null>",
  "description": "<one-line operator-facing>",
  "rationale":   "<why this revised version addresses the feedback>"
}`

  let parsed: { target: string | null; description: string; rationale: string } | null = null
  try {
    const resp = await callAnthropic(anthropic, {
      model:      RESHAPE_MODEL,
      max_tokens: 1000,
      messages:   [{ role: 'user', content: prompt }],
    }, { label: 'opportunity-reshape' })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
    parsed = extractJson(text)
  } catch (err) {
    logger.warn('reshape_llm_failed', {
      sourceId: src.id, err: String(err).slice(0, 200),
    })
    return null
  }

  if (!parsed || !parsed.description) return null

  const descendantId = uuid()
  await pool.query(
    `INSERT INTO seo_opportunities (
       id, tenant_id, run_id, type, target,
       description, rationale, priority, status,
       reshape_source_id, reshape_count, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'new', $9, $10, NOW(), NOW())`,
    [
      descendantId, src.tenantId, src.id, src.type,
      typeof parsed.target === 'string' ? parsed.target : null,
      parsed.description.slice(0, 500),
      typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 1000) : null,
      src.priority,
      src.id,                       // reshape_source_id
      src.reshapeCount + 1,         // reshape_count
    ],
  )
  return { id: descendantId }
}

function extractJson(text: string): { target: string | null; description: string; rationale: string } | null {
  try { return JSON.parse(text) } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
  try { return JSON.parse(stripped) } catch { /* fall through */ }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* give up */ }
  }
  return null
}
