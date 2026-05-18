// src/skills/seo-backlink-prospector/index.ts
//
// Entry point for the SEO-5 backlink prospecting weekly cron. Runs:
//
//   1. Refresh our backlink inventory (DataForSEO → seo.backlink_inventory)
//   2. Find competitor-gap prospects (their backlinks we don't have)
//   3. For each candidate: check spam-safety caps, draft outreach email,
//      file an opportunity with the draft in `detail` JSONB
//
// Customer never sees the cycle — output is silent, logs only. The next
// daily run consumes the opportunities via pickForDailyRun (foundation
// bundle).

import { v4 as uuid } from 'uuid'
import { logger } from '../../logger'
import { getTenant } from '../../tenants/registry'
import { canProspect } from '../../core/outreach-safety'
import { draftOutreach } from '../../core/outreach-drafter'
import { refreshOwnInventory } from './inventory'
import { findCompetitorGapProspects } from './competitor-gap'
import { fileProspectAsOpportunity } from './store'
import { ProspectCycleResult } from './types'

export async function runBacklinkProspectCycle(tenantId: string): Promise<ProspectCycleResult> {
  const runId = uuid()
  logger.info('backlink_prospect_cycle_starting', { tenantId, runId })

  let tenant
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    const e = `tenant_not_found_${tenantId}`
    logger.error('backlink_prospect_cycle_failed', {
      tenantId, err: String(err).slice(0, 200),
    })
    return emptyResult(tenantId, [e])
  }

  // Opt-out check.
  const disabled = tenant.disabledOpportunityTypes ?? []
  if (disabled.includes('pursue_backlink')) {
    logger.info('backlink_prospect_cycle_skipped_disabled', { tenantId })
    return emptyResult(tenantId, [])
  }

  const result: ProspectCycleResult = {
    tenantId,
    inventoryFetched:      0,
    inventoryNew:          0,
    competitorsScanned:    0,
    candidatesIdentified:  0,
    candidatesAfterSafety: 0,
    opportunitiesFiled:    0,
    draftsGenerated:       0,
    errors:                [],
  }

  // ── 1. Refresh inventory ──────────────────────────────────────────────
  try {
    const inv = await refreshOwnInventory({ tenant })
    result.inventoryFetched = inv.fetched
    result.inventoryNew     = inv.inserted
  } catch (err) {
    const e = `inventory_refresh_failed: ${String(err).slice(0, 200)}`
    result.errors.push(e)
    logger.error('backlink_inventory_refresh_failed', { tenantId, err: e })
  }

  // ── 2. Find competitor-gap prospects ──────────────────────────────────
  let prospects: Awaited<ReturnType<typeof findCompetitorGapProspects>>
  try {
    prospects = await findCompetitorGapProspects({ tenant })
    result.competitorsScanned   = prospects.competitorsScanned
    result.candidatesIdentified = prospects.prospects.length
  } catch (err) {
    const e = `competitor_gap_failed: ${String(err).slice(0, 200)}`
    result.errors.push(e)
    logger.error('backlink_gap_scan_failed', { tenantId, err: e })
    logger.info('backlink_prospect_cycle_completed', result)
    return result
  }

  // ── 3. Safety + draft + file ──────────────────────────────────────────
  for (const p of prospects.prospects) {
    // Safety gate.
    let safety: Awaited<ReturnType<typeof canProspect>>
    try {
      safety = await canProspect({
        tenantId,
        targetSite: p.sourceDomain,
      })
    } catch (err) {
      result.errors.push(`safety_check_failed_for_${p.sourceDomain}`)
      continue
    }
    if (!safety.allowed) {
      logger.info('backlink_prospect_blocked_by_safety', {
        tenantId, sourceDomain: p.sourceDomain, reason: safety.reason,
      })
      continue
    }
    result.candidatesAfterSafety++

    // Draft (best-effort — file even if drafting fails).
    let draft: Awaited<ReturnType<typeof draftOutreach>> | null = null
    try {
      draft = await draftOutreach({
        prospectType: 'backlink_gap',
        targetSite:   p.sourceDomain,
        targetUrl:    p.sourceUrl,
        tenantName:   tenant.clientName,
        tenantDomain: tenant.targetDomain ?? '',
        ourUrl:       null,
        context:
          `Competitor ${p.competitorDomain} earned a link from ${p.sourceDomain} (DR ${p.sourceDr ?? '?'}) ` +
          `pointing at ${p.competitorTargetUrl}` +
          (p.anchorText ? ` with anchor text "${p.anchorText}"` : '') + '.',
      })
      if (draft) result.draftsGenerated++
    } catch (err) {
      // swallow — we still file
      logger.warn('backlink_prospect_draft_failed', {
        tenantId, sourceDomain: p.sourceDomain,
        err: String(err).slice(0, 200),
      })
    }

    // File.
    try {
      await fileProspectAsOpportunity({
        tenantId, runId, prospect: p, draft,
      })
      result.opportunitiesFiled++
    } catch (err) {
      const e = `file_failed_${p.sourceDomain}: ${String(err).slice(0, 100)}`
      result.errors.push(e)
      logger.warn('backlink_prospect_file_failed', {
        tenantId, sourceDomain: p.sourceDomain, err: e,
      })
    }
  }

  logger.info('backlink_prospect_cycle_completed', result)
  return result
}

function emptyResult(tenantId: string, errors: string[]): ProspectCycleResult {
  return {
    tenantId,
    inventoryFetched:      0,
    inventoryNew:          0,
    competitorsScanned:    0,
    candidatesIdentified:  0,
    candidatesAfterSafety: 0,
    opportunitiesFiled:    0,
    draftsGenerated:       0,
    errors,
  }
}
