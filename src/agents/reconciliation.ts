// src/agents/reconciliation.ts
//
// Post-loop reconciliation between what a specialist CLAIMED in its
// output.md and what actually happened in the database.
//
// Failure mode this addresses (observed 12 May with the /home-2 test):
//   The specialist's final output said "the change has been proposed and
//   is sitting in preview, waiting for your approval." No row existed in
//   approval_requests. The agent hallucinated the propose_action call.
//   Nothing in the loop noticed; the aggregator and Slack presenter both
//   trusted the narrative.
//
// How this module works:
//   1. captureBaselineCounts(taskId, tenantId) is called at the top of
//      runSubagent BEFORE the model loop starts. It snapshots row counts
//      across the tables specialists write to.
//   2. reconcileOutput(opts) is called AFTER the loop, BEFORE writing
//      output.md. It captures final counts, computes deltas (what THIS
//      run actually wrote), scans finalOutput for claim phrases, and
//      returns a reconciled output string.
//   3. If claims > actual writes → prepends a HALLUCINATION warning to
//      output.md so the aggregator excludes the unverified claims.
//   4. Appends a "## Verified DB writes" section that lists actual rows
//      with IDs. The aggregator treats this section as authoritative.
//
// Tables tracked:
//   - approval_requests   (task_id keyed)
//   - seo_work_log        (run_id keyed)
//   - seo_opportunities   (run_id keyed)
//   - agent_learnings     (tenant-keyed; tracked as a coarse counter)
//
// NOT tracked (intentionally):
//   - seo_metrics_snapshots — no run_id column on the table, so we
//     cannot reliably attribute a snapshot to a specific run.
//   - seo_clusters — updated via upsert (existing row mutated), so a
//     count delta doesn't capture "this run touched this cluster".
//
// Claim phrase detection is intentionally conservative (whitelist of
// strong past-tense / present-perfect verbs). False positives are worse
// than false negatives here.

import { pool } from '../memory/postgres'
import { logger } from '../logger'

// ── Types ─────────────────────────────────────────────────────────────────

export interface ReconciliationCounts {
  approvalRequests: number
  seoWorkLog:       number
  seoOpportunities: number
  agentLearnings:   number
}

export interface ReconciliationDelta {
  approvalRequests: number
  seoWorkLog:       number
  seoOpportunities: number
  agentLearnings:   number
}

export interface ReconciliationEvidence {
  approvals:     Array<{ id: string; toolName: string; priority: string; proposedAction: string }>
  workLog:       Array<{ id: string; actionType: string; summary: string; status: string }>
  opportunities: Array<{ id: string; description: string; priority: string }>
}

export interface ClaimDetection {
  count:   number
  samples: string[]
}

export interface ReconcileResult {
  reconciledOutput: string
  delta:    ReconciliationDelta
  claims:   ClaimDetection
  mismatch: 'none' | 'hallucination' | 'under_reporting'
  evidence: ReconciliationEvidence
}

// ── Baseline + final capture ──────────────────────────────────────────────

/**
 * Snapshot current row counts for this tenant + parent task. Called at
 * the top of runSubagent before any model calls.
 *
 * Why parent task ID:
 *   approval_requests is keyed by task_id (parent task ID); seo_work_log
 *   and seo_opportunities are keyed by run_id = parent task ID.
 *   Multiple specialists on the same parent task share that key. We
 *   diff baseline → final to derive what changed during this subagent
 *   run.
 *
 * Caveat: if two specialists for the same parent task run in parallel
 * and both write, each will see the other's writes in its delta. That's
 * acceptable for MVP. Future: per-subtask attribution via subtask_id
 * column on the write tables.
 */
export async function captureBaselineCounts(
  parentTaskId: string,
  tenantId: string,
): Promise<ReconciliationCounts> {
  try {
    const [approvals, work, opps, learnings] = await Promise.all([
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM approval_requests WHERE tenant_id=$1 AND task_id=$2',
        [tenantId, parentTaskId],
      ),
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM seo_work_log WHERE tenant_id=$1 AND run_id::text=$2',
        [tenantId, parentTaskId],
      ),
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM seo_opportunities WHERE tenant_id=$1 AND run_id::text=$2',
        [tenantId, parentTaskId],
      ),
      pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM agent_learnings WHERE tenant_id=$1',
        [tenantId],
      ),
    ])

    return {
      approvalRequests: parseInt(approvals.rows[0]?.count ?? '0', 10),
      seoWorkLog:       parseInt(work.rows[0]?.count ?? '0', 10),
      seoOpportunities: parseInt(opps.rows[0]?.count ?? '0', 10),
      agentLearnings:   parseInt(learnings.rows[0]?.count ?? '0', 10),
    }
  } catch (err) {
    logger.warn('reconciliation_baseline_capture_failed', {
      parentTaskId, tenantId, err: String(err).slice(0, 200),
    })
    return emptyCounts()
  }
}

async function captureFinalCounts(
  parentTaskId: string,
  tenantId: string,
): Promise<ReconciliationCounts> {
  return captureBaselineCounts(parentTaskId, tenantId)
}

function emptyCounts(): ReconciliationCounts {
  return {
    approvalRequests: 0,
    seoWorkLog:       0,
    seoOpportunities: 0,
    agentLearnings:   0,
  }
}

function computeDelta(
  baseline: ReconciliationCounts,
  final:    ReconciliationCounts,
): ReconciliationDelta {
  return {
    approvalRequests: Math.max(0, final.approvalRequests - baseline.approvalRequests),
    seoWorkLog:       Math.max(0, final.seoWorkLog - baseline.seoWorkLog),
    seoOpportunities: Math.max(0, final.seoOpportunities - baseline.seoOpportunities),
    agentLearnings:   Math.max(0, final.agentLearnings - baseline.agentLearnings),
  }
}

// ── Evidence fetch ─────────────────────────────────────────────────────────

async function fetchEvidence(
  parentTaskId: string,
  tenantId: string,
  delta: ReconciliationDelta,
): Promise<ReconciliationEvidence> {
  const evidence: ReconciliationEvidence = {
    approvals: [],
    workLog: [],
    opportunities: [],
  }

  try {
    if (delta.approvalRequests > 0) {
      const r = await pool.query<{
        id: string; tool_name: string; risk_level: string; tool_input: Record<string, unknown>
      }>(
        `SELECT id, tool_name, risk_level, tool_input
         FROM approval_requests
         WHERE tenant_id=$1 AND task_id=$2
         ORDER BY requested_at DESC
         LIMIT 50`,
        [tenantId, parentTaskId],
      )
      evidence.approvals = r.rows.map(row => ({
        id:             row.id,
        toolName:       row.tool_name,
        priority:       row.risk_level,
        proposedAction: extractProposedAction(row.tool_input),
      }))
    }

    if (delta.seoWorkLog > 0) {
      const r = await pool.query<{
        id: string; action_type: string; summary: string; status: string
      }>(
        `SELECT id, action_type, summary, status
         FROM seo_work_log
         WHERE tenant_id=$1 AND run_id::text=$2
         ORDER BY executed_at DESC
         LIMIT 50`,
        [tenantId, parentTaskId],
      )
      evidence.workLog = r.rows.map(row => ({
        id:         row.id,
        actionType: row.action_type,
        summary:    row.summary,
        status:     row.status,
      }))
    }

    if (delta.seoOpportunities > 0) {
      const r = await pool.query<{
        id: string; description: string; priority: string
      }>(
        `SELECT id, description, priority
         FROM seo_opportunities
         WHERE tenant_id=$1 AND run_id::text=$2
         ORDER BY created_at DESC
         LIMIT 50`,
        [tenantId, parentTaskId],
      )
      evidence.opportunities = r.rows.map(row => ({
        id:          row.id,
        description: row.description,
        priority:    row.priority,
      }))
    }
  } catch (err) {
    logger.warn('reconciliation_evidence_fetch_failed', {
      parentTaskId, tenantId, err: String(err).slice(0, 200),
    })
  }

  return evidence
}

function extractProposedAction(toolInput: unknown): string {
  if (toolInput && typeof toolInput === 'object' && 'proposedAction' in toolInput) {
    const v = (toolInput as { proposedAction?: unknown }).proposedAction
    if (typeof v === 'string') return v
  }
  return '(no proposedAction recorded)'
}

// ── Claim detection ────────────────────────────────────────────────────────

const WRITE_CLAIM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bI(?:'ve| have)\s+proposed\b/i, label: "I've proposed" },
  { pattern: /\bI(?:'ve| have)\s+filed\s+an?\s+(?:approval|proposal)\b/i, label: "I've filed an approval" },
  { pattern: /\bproposal\s+(?:has been|was)\s+(?:filed|created|submitted)\b/i, label: 'proposal has been filed' },
  { pattern: /\bthe\s+change\s+has\s+been\s+proposed\b/i, label: 'the change has been proposed' },
  { pattern: /\b(?:has been|was|is)\s+queued\s+for\s+approval\b/i, label: 'queued for approval' },
  { pattern: /\bI(?:'ve| have)\s+queued\b/i, label: "I've queued" },
  { pattern: /\bI(?:'ve| have)\s+logged\b/i, label: "I've logged" },
  { pattern: /\bI(?:'ve| have)\s+shipped\b/i, label: "I've shipped" },
  { pattern: /\bI(?:'ve| have)\s+recorded\b/i, label: "I've recorded" },
  { pattern: /\baction\s+filed\b/i, label: 'action filed' },
  { pattern: /\bapproval\s+(?:filed|created)\b/i, label: 'approval filed' },
]

/**
 * Scan a finalOutput string for write claims. Code fences and inline
 * backticks are stripped first so the agent can quote example code
 * without triggering matches.
 */
export function detectWriteClaims(finalOutput: string): ClaimDetection {
  const stripped = finalOutput
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')

  const samples: string[] = []
  for (const { pattern, label } of WRITE_CLAIM_PATTERNS) {
    if (pattern.test(stripped)) {
      samples.push(label)
    }
  }

  return { count: samples.length, samples }
}

// ── Suffix and warning generation ──────────────────────────────────────────

function buildVerifiedSuffix(
  delta: ReconciliationDelta,
  evidence: ReconciliationEvidence,
): string {
  const sections: string[] = ['## Verified DB writes']

  if (delta.approvalRequests > 0) {
    sections.push(`### Approval requests filed (${delta.approvalRequests})`)
    for (const a of evidence.approvals) {
      sections.push(`- \`${a.id.slice(0, 8)}\` [${a.priority}] ${a.toolName} — ${a.proposedAction}`)
    }
  }
  if (delta.seoWorkLog > 0) {
    sections.push(`### Work log entries (${delta.seoWorkLog})`)
    for (const w of evidence.workLog) {
      sections.push(`- \`${w.id.slice(0, 8)}\` [${w.status}] ${w.actionType}: ${w.summary}`)
    }
  }
  if (delta.seoOpportunities > 0) {
    sections.push(`### Opportunities surfaced (${delta.seoOpportunities})`)
    for (const o of evidence.opportunities) {
      sections.push(`- \`${o.id.slice(0, 8)}\` [${o.priority}] ${o.description}`)
    }
  }
  if (delta.agentLearnings > 0) {
    sections.push(`### Memories recorded: ${delta.agentLearnings}`)
  }

  return sections.join('\n')
}

function buildHallucinationWarning(
  claims: ClaimDetection,
  delta: ReconciliationDelta,
): string {
  return [
    '> ⚠️ HALLUCINATION DETECTED — RECONCILIATION CHECK FAILED',
    '>',
    `> This specialist's output contains ${claims.count} write claim(s) (${claims.samples.join(', ')})`,
    `> but the database shows only ${delta.approvalRequests} approval(s), ${delta.seoWorkLog} work log entry(ies),`,
    `> and ${delta.seoOpportunities} opportunity(ies) actually written during this run.`,
    '>',
    "> The aggregator will treat the unverified claims as NOT done. The operator should",
    '> not assume the claimed work has been queued or shipped. Re-run with the same task',
    '> if the work is still needed.',
    '',
  ].join('\n')
}

// ── Main entry point ──────────────────────────────────────────────────────

export async function reconcileOutput(opts: {
  finalOutput:    string
  parentTaskId:   string
  tenantId:       string
  subTaskId:      string
  specialistType: string
  baseline:       ReconciliationCounts
}): Promise<ReconcileResult> {
  const { finalOutput, parentTaskId, tenantId, subTaskId, specialistType, baseline } = opts

  const final    = await captureFinalCounts(parentTaskId, tenantId)
  const delta    = computeDelta(baseline, final)
  const claims   = detectWriteClaims(finalOutput)
  const evidence = await fetchEvidence(parentTaskId, tenantId, delta)

  const totalWrites =
    delta.approvalRequests +
    delta.seoWorkLog +
    delta.seoOpportunities +
    delta.agentLearnings

  let mismatch: ReconcileResult['mismatch'] = 'none'
  if (claims.count > 0 && totalWrites === 0) {
    mismatch = 'hallucination'
  } else if (claims.count === 0 && totalWrites > 0) {
    mismatch = 'under_reporting'
  }

  let reconciledOutput = finalOutput

  if (mismatch === 'hallucination') {
    const warning = buildHallucinationWarning(claims, delta)
    reconciledOutput = warning + '\n' + reconciledOutput
    logger.warn('reconciliation_hallucination_detected', {
      parentTaskId, tenantId, subTaskId, specialistType,
      claims: claims.samples, delta,
    })
  }

  if (totalWrites > 0) {
    const suffix = buildVerifiedSuffix(delta, evidence)
    reconciledOutput = reconciledOutput.trimEnd() + '\n\n' + suffix + '\n'
  }

  if (mismatch === 'under_reporting') {
    logger.info('reconciliation_under_reporting', {
      parentTaskId, tenantId, subTaskId, specialistType, delta,
    })
  }

  logger.info('reconciliation_complete', {
    parentTaskId, tenantId, subTaskId, specialistType,
    claims: claims.count, totalWrites, mismatch,
  })

  return { reconciledOutput, delta, claims, mismatch, evidence }
}
