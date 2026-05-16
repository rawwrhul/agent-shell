// src/memory/pipeline-events.ts
//
// L2 memory write hooks fired at pipeline checkpoints. Captures the
// terminal outcome of every propose_action so the agent compounds
// operator decisions across runs.
//
// Design principles:
//   - One entry per pipeline outcome (terminal state only).
//   - Transitions DELETE prior entries so memory stays sharp.
//   - Single-line values, sharp and compressed.
//   - Best-effort — never blocks the main flow.

import { logger } from '../logger'
import { recordMemory, forgetMemory } from './runtime'

const today = (): string => new Date().toISOString().slice(0, 10)

const snip = (s: string | null | undefined, max = 80): string => {
  if (!s) return ''
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s
}

const sfx = (toolName: string, approvalId: string): string =>
  `${toolName}-${approvalId.slice(0, 8)}`

// ── Hook 1: approval resolved (approved or rejected) ─────────────────────
//
// Writes a single L2 entry capturing the operator's decision. For blog
// pitch Stage 1 approvals, this entry will later be REPLACED by either
// onPublishSucceeded (→ 'published-{slug}') or onPublishFailed (→
// 'publish-failed-{slug}'). For non-blog approvals, this entry is terminal.
//
// For Stage 2 rejections (operator approved the pitch at Stage 1, then
// rejected the rendered draft), this deletes the prior 'pitch-approved-{slug}'
// entry first so we end up with one consolidated 'draft-rejected-{slug}'.

export async function onApprovalResolved(params: {
  approvalId:       string
  tenantId:         string
  toolName:         string
  proposedAction:   string | null
  toolInput:        Record<string, unknown>
  status:           'approved' | 'rejected'
  resolvedBy:       string
  rejectionReason?: string | null
}): Promise<void> {
  const { approvalId, tenantId, toolName, proposedAction, toolInput, status, resolvedBy, rejectionReason } = params

  try {
    const slug = typeof toolInput?.slug === 'string' ? toolInput.slug : undefined
    const action = proposedAction ?? toolName
    const date = today()
    const idShort = sfx(toolName, approvalId)
    const isStage1Pitch = toolName === 'approve_blog_pitch'
    const isStage2Pitch = toolName === 'framer_confirm_publish'

    if (status === 'approved') {
      // Stage 1 pitch approval → 'pitch-approved-{slug}' (will be replaced by publish).
      // Stage 2 pitch approval → same key 'pitch-approved-{slug}' (overwrites Stage 1
      //   entry with the more recent state, then executor will replace with published-).
      // Non-blog approvals → 'shipped-{toolName-id}' (terminal).
      const key =
        (isStage1Pitch || isStage2Pitch) && slug
          ? `pitch-approved-${slug}`
          : `shipped-${idShort}`

      await recordMemory({
        tenantId,
        type:       'learning',
        key,
        value:      `[Approved ${date}] ${toolName}: ${snip(action)}. By ${resolvedBy}.`,
        confidence: 1.0,
      })
      return
    }

    // status === 'rejected'
    // If this is Stage 2 reject (draft was reviewed and rejected after Stage 1
    // approval), delete the prior 'pitch-approved' entry to consolidate.
    if (isStage2Pitch && slug) {
      try { await forgetMemory({ tenantId, type: 'learning', key: `pitch-approved-${slug}` }) } catch { /* may not exist */ }
    }

    const rejectKey =
      isStage2Pitch && slug ? `draft-rejected-${slug}`
      : isStage1Pitch && slug ? `pitch-rejected-${slug}`
      : `rejected-${idShort}`

    const reasonSnip = snip(rejectionReason || 'no reason given', 120)

    await recordMemory({
      tenantId,
      type:       'loss',
      key:        rejectKey,
      value:      `[Rejected ${date}] ${toolName}: ${snip(action)}. Reason: ${reasonSnip}. By ${resolvedBy}.`,
      confidence: 1.0,
    })
  } catch (err) {
    logger.warn('pipeline_hook_approval_resolved_failed', {
      approvalId, tenantId, status,
      err: String(err).slice(0, 300),
    })
  }
}

// ── Hook 2: executor publish succeeded ────────────────────────────────────
//
// Fires from src/integrations/framer/executor.ts after both confirmPublish
// AND deployToProduction succeed. REPLACES the prior 'pitch-approved-{slug}'
// entry with a 'published-{slug}' entry (terminal state for the pipeline).

export async function onPublishSucceeded(params: {
  tenantId:      string
  slug:          string
  title?:        string
  productionUrl?: string
}): Promise<void> {
  const { tenantId, slug, title, productionUrl } = params

  try {
    // Delete the prior 'pitch-approved-{slug}' entry (from Stage 1/Stage 2 approval).
    try { await forgetMemory({ tenantId, type: 'learning', key: `pitch-approved-${slug}` }) } catch { /* may not exist */ }

    const titlePart = title ? `"${snip(title, 60)}" → ` : ''
    const urlPart = productionUrl ?? `/resources/${slug}`

    await recordMemory({
      tenantId,
      type:       'learning',
      key:        `published-${slug}`,
      value:      `[Published ${today()}] ${titlePart}${urlPart}.`,
      confidence: 1.0,
    })
  } catch (err) {
    logger.warn('pipeline_hook_publish_succeeded_failed', {
      tenantId, slug, err: String(err).slice(0, 300),
    })
  }
}

// ── Hook 3: executor publish failed ───────────────────────────────────────
//
// Fires when deployToProduction throws (e.g. Phase 9e staging-dirty refusal,
// Framer SDK error). REPLACES the prior 'pitch-approved-{slug}' entry with
// a 'publish-failed-{slug}' loss entry capturing the error.

export async function onPublishFailed(params: {
  tenantId: string
  slug:     string
  error:    string
}): Promise<void> {
  const { tenantId, slug, error } = params

  try {
    try { await forgetMemory({ tenantId, type: 'learning', key: `pitch-approved-${slug}` }) } catch { /* may not exist */ }

    await recordMemory({
      tenantId,
      type:       'loss',
      key:        `publish-failed-${slug}`,
      value:      `[Publish failed ${today()}] /resources/${slug}. Error: ${snip(error, 120)}.`,
      confidence: 1.0,
    })
  } catch (err) {
    logger.warn('pipeline_hook_publish_failed_record_failed', {
      tenantId, slug, err: String(err).slice(0, 300),
    })
  }
}

// ── Hook 4: site crawl completed ──────────────────────────────────────────
//
// Fires from src/core/crawler/crawler.ts after finishCrawlRun() succeeds.
// Writes a single L2 fact entry (key='site-inventory') capturing the latest
// crawl's summary stats so future agent runs see it as ambient context
// without needing to call the crawler tools first. Each crawl overwrites
// the prior entry — the agent only ever sees the most recent inventory.

export async function onCrawlCompleted(params: {
  tenantId:         string
  pagesCrawled:     number
  pagesFailed:      number
  pagesSkipped:     number
  statusBreakdown:  Record<string, number>
  pagesMissingH1:   number
  pagesMissingMeta: number
  orphanedPages:    number
  internalEdges:    number
}): Promise<void> {
  const {
    tenantId, pagesCrawled, pagesFailed, pagesSkipped, statusBreakdown,
    pagesMissingH1, pagesMissingMeta, orphanedPages, internalEdges,
  } = params

  try {
    const date = today()
    const statusStr = Object.entries(statusBreakdown)
      .sort()
      .map(([k, v]) => `${v} ${k}`)
      .join(', ') || 'unknown'

    const failPart = pagesFailed ? `, ${pagesFailed} failed` : ''
    const skipPart = pagesSkipped ? `, ${pagesSkipped} skipped` : ''

    const issues: string[] = []
    if (orphanedPages    > 0) issues.push(`${orphanedPages} orphan${orphanedPages === 1 ? '' : 's'}`)
    if (pagesMissingH1   > 0) issues.push(`${pagesMissingH1} missing H1`)
    if (pagesMissingMeta > 0) issues.push(`${pagesMissingMeta} missing meta`)
    const issuesPart = issues.length ? `. Issues: ${issues.join(', ')}` : '. No structural issues found'

    const value = `[Crawled ${date}] ${pagesCrawled} pages (${statusStr})${failPart}${skipPart}${issuesPart}. ${internalEdges} internal edges.`

    await recordMemory({
      tenantId,
      type:       'fact',
      key:        'site-inventory',
      value,
      confidence: 1.0,
    })
  } catch (err) {
    logger.warn('pipeline_hook_crawl_completed_failed', {
      tenantId, err: String(err).slice(0, 300),
    })
  }
}

