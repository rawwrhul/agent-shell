// src/skills/seo-technical-auditor/index.ts
//
// Audit entrypoint. Two exported functions:
//
//   runAudit(tenantId)            — runs an audit against the latest crawl data
//   runFullAuditCycle(tenantId)   — crawl + audit + memory write (cron-callable)
//
// runAudit is the heart. The cycle wrapper adds crawl-first semantics so the
// audit always runs against fresh data.

import { v4 as uuid } from 'uuid'
import { logger } from '../../logger'
import { recordMemory, getMemoryByKey } from '../../memory/runtime'
import { runCrawl } from '../../core/crawler'
import {
  startAuditRun,
  finishAuditRun,
  getLatestCrawlRunId,
  loadPageInventory,
  loadInternalLinks,
  loadPriorFindings,
  upsertFinding,
  markResolved,
  createOpportunity,
  buildExclusionSet,
} from './store'
import { ALL_CHECKS } from './checks'
import { applyNavHeuristic } from './nav-heuristic'
import { fetchSitemapUrls } from './sitemap'
import { computeDelta } from './delta'
import { synthesizeAudit } from './synthesis'
import type { AuditSummary, CheckContext, RawFinding, Severity } from './types'
import { getTenant } from '../../tenants/registry'

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Run an audit against the LATEST crawl data the tenant has. Does NOT
 * trigger a crawl itself — call runFullAuditCycle for that. Returns a
 * summary the caller can inspect; also writes findings + opportunities
 * + L2 narrative.
 */
export async function runAudit(tenantId: string): Promise<AuditSummary> {
  const auditRunId = uuid()
  const startedAt = new Date()

  const tenant = await getTenant(tenantId)
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`)
  }

  const crawlRunId = await getLatestCrawlRunId(tenantId)
  await startAuditRun({ runId: auditRunId, tenantId, crawlRunId })

  logger.info('audit_run_started', {
    auditRunId, tenantId, crawlRunId,
  })

  let summary: AuditSummary
  try {
    summary = await runChecks({ auditRunId, tenantId, tenantName: tenant.clientName, crawlRunId, startedAt })

    await finishAuditRun({
      runId:                auditRunId,
      status:               'completed',
      findingsTotal:        summary.findingsTotal,
      findingsNew:          summary.findingsNew,
      findingsPersistent:   summary.findingsPersistent,
      findingsResolved:     summary.findingsResolved,
      opportunitiesCreated: summary.opportunitiesCreated,
      narrative:            summary.narrative,
      error:                null,
    })

    // L2 memory write — narrative is the ambient context for future runs.
    try {
      await recordMemory({
        tenantId,
        type:       'fact',
        key:        'audit-summary',
        value:      summary.narrative,
        confidence: 1.0,
      })
    } catch (err) {
      logger.warn('audit_memory_write_failed', {
        auditRunId, tenantId, err: String(err).slice(0, 200),
      })
    }

    logger.info('audit_run_completed', {
      auditRunId, tenantId,
      findingsTotal: summary.findingsTotal,
      findingsNew: summary.findingsNew,
      findingsPersistent: summary.findingsPersistent,
      findingsResolved: summary.findingsResolved,
      opportunitiesCreated: summary.opportunitiesCreated,
      durationMs: summary.durationMs,
    })
  } catch (err) {
    const errMsg = String(err).slice(0, 500)
    await finishAuditRun({
      runId:                auditRunId,
      status:               'failed',
      findingsTotal:        0,
      findingsNew:          0,
      findingsPersistent:   0,
      findingsResolved:     0,
      opportunitiesCreated: 0,
      narrative:            null,
      error:                errMsg,
    })
    logger.error('audit_run_failed', { auditRunId, tenantId, err: errMsg })
    throw err
  }

  return summary
}

/**
 * Crawl + audit + memory in one shot. Invoked by the scheduler on the
 * Saturday-midnight cron. Throws if the crawl fails fatally; per-page
 * crawl failures are handled inside runCrawl and don't propagate here.
 */
export async function runFullAuditCycle(tenantId: string): Promise<AuditSummary> {
  const tenant = await getTenant(tenantId)
  if (!tenant) throw new Error(`Tenant not found: ${tenantId}`)
  if (!tenant.targetDomain) {
    throw new Error(`Tenant ${tenantId} has no target_domain set; cannot run cycle`)
  }

  const normalizedDomain = tenant.targetDomain.startsWith('http')
    ? tenant.targetDomain
    : `https://${tenant.targetDomain}`

  const seeds = [
    normalizedDomain.endsWith('/') ? normalizedDomain : `${normalizedDomain}/`,
    new URL('/sitemap.xml', normalizedDomain).href,
  ]

  logger.info('audit_cycle_starting_crawl', { tenantId, seeds })

  const crawlSummary = await runCrawl({
    tenantId,
    seedUrls:  seeds,
    crawlKind: 'full',
    maxPages:  500,
    maxDepth:  8,
  })
  logger.info('audit_cycle_crawl_done', {
    tenantId,
    pagesCrawled: crawlSummary.pagesCrawled,
    pagesFailed:  crawlSummary.pagesFailed,
  })

  if (crawlSummary.status !== 'completed') {
    throw new Error(`Crawl failed for ${tenantId}: ${crawlSummary.error ?? 'unknown'}`)
  }

  return runAudit(tenantId)
}

// ── Internals ──────────────────────────────────────────────────────────

async function runChecks(args: {
  auditRunId:  string
  tenantId:    string
  tenantName:  string
  crawlRunId:  string | null
  startedAt:   Date
}): Promise<AuditSummary> {
  const { auditRunId, tenantId, tenantName, startedAt } = args

  // ── Load inputs in parallel ────────────────────────────────────────
  const tenant = await getTenant(tenantId)
  const targetDomain = tenant?.targetDomain ?? null

  const [pages, rawLinks, sitemapUrls, priorFindings, inventoryMem] = await Promise.all([
    loadPageInventory(tenantId),
    loadInternalLinks(tenantId),
    targetDomain ? fetchSitemapUrls(targetDomain) : Promise.resolve(new Set<string>()),
    loadPriorFindings(tenantId),
    getMemoryByKey(tenantId, 'fact', 'site-inventory').catch(() => null),
  ])

  if (pages.length === 0) {
    logger.warn('audit_no_inventory', { tenantId })
    return {
      auditRunId, tenantId, status: 'completed',
      startedAt, completedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
      findingsTotal: 0, findingsNew: 0, findingsPersistent: 0, findingsResolved: 0,
      opportunitiesCreated: 0,
      severityCounts: { P0: 0, P1: 0, P2: 0, P3: 0 },
      narrative: '[Audit skipped] No crawl data exists for this tenant. Run npm run crawl first.',
      error: null,
    }
  }

  // ── Pre-pass: nav heuristic ────────────────────────────────────────
  const links = applyNavHeuristic(rawLinks, pages)

  // ── Build check context ─────────────────────────────────────────────
  const ctx: CheckContext = {
    tenantId,
    pages,
    links,
    sitemapUrls,
    excludeFromOrphans: buildExclusionSet(pages),
  }

  // ── Run all checks (collect findings) ──────────────────────────────
  const rawFindings: RawFinding[] = []
  for (const check of ALL_CHECKS) {
    try {
      const result = await check.fn(ctx)
      rawFindings.push(...result)
    } catch (err) {
      logger.warn('audit_check_failed', {
        auditRunId, checkName: check.name, err: String(err).slice(0, 300),
      })
    }
  }

  // ── Delta pass: match against prior, compute states ────────────────
  const now = new Date()
  const { findings: resolved, resolvedIds } = computeDelta({
    current: rawFindings,
    prior:   priorFindings,
    now,
  })

  // ── Persist findings ───────────────────────────────────────────────
  const persistedFindings = []
  let newCount = 0
  let persistentCount = 0
  for (const f of resolved) {
    const id = await upsertFinding({ tenantId, auditRunId, finding: f }).catch((err) => {
      logger.warn('audit_finding_upsert_failed', {
        auditRunId, findingKey: f.findingKey, err: String(err).slice(0, 300),
      })
      return null
    })
    if (!id) continue
    f.id = id
    persistedFindings.push(f)
    if (f.state === 'new') newCount++
    else if (f.state === 'persistent') persistentCount++
  }

  // Mark resolved ones
  for (const r of resolvedIds) {
    await markResolved({ findingId: r.id, auditRunId }).catch((err) => {
      logger.warn('audit_finding_mark_resolved_failed', {
        auditRunId, findingKey: r.findingKey, err: String(err).slice(0, 300),
      })
    })
  }

  // Build a quick map for the synthesis layer's resolved-context
  const resolvedThisAudit = Array.from(priorFindings.values())
    .filter((p) => resolvedIds.some((r) => r.id === p.id))

  // ── Synthesis (LLM) ────────────────────────────────────────────────
  const inventoryValue = typeof inventoryMem?.value === 'string' ? inventoryMem.value : null
  const synthesis = await synthesizeAudit({
    tenantId, tenantName,
    findings:           persistedFindings.filter((f) => f.state !== 'ignored'),
    resolvedThisAudit,
    inventorySummary:   inventoryValue,
    brandMemorySummary: null,  // could be populated by reading other tenant_memory keys later
  })

  // ── Persist opportunities ──────────────────────────────────────────
  let opportunitiesCreated = 0
  for (const o of synthesis.opportunities) {
    const sourceFindingId = o.findingIds[0] ?? null
    try {
      await createOpportunity({
        tenantId,
        auditRunId,
        type:            o.type,
        target:          o.target,
        description:     o.description,
        rationale:       o.rationale,
        priority:        o.priority,
        estimatedImpact: o.estimatedImpact,
        sourceFindingId,
      })
      opportunitiesCreated++
    } catch (err) {
      logger.warn('audit_opportunity_create_failed', {
        auditRunId, type: o.type, err: String(err).slice(0, 300),
      })
    }
  }

  // ── Severity counts (active findings only) ──────────────────────────
  const severityCounts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
  for (const f of persistedFindings) {
    if (f.state === 'new' || f.state === 'persistent') {
      severityCounts[f.severity]++
    }
  }

  const completedAt = new Date()
  return {
    auditRunId,
    tenantId,
    status:             'completed',
    startedAt,
    completedAt,
    durationMs:         completedAt.getTime() - startedAt.getTime(),
    findingsTotal:      persistedFindings.length,
    findingsNew:        newCount,
    findingsPersistent: persistentCount,
    findingsResolved:   resolvedIds.length,
    opportunitiesCreated,
    severityCounts,
    narrative:          synthesis.narrative,
    error:              null,
  }
}
