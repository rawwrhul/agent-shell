// src/core/metrics/sync.ts
//
// The metrics_sync cycle: pull trailing windows of GSC + GA4 data into
// ranking_history / traffic_history for one tenant. Pure data job — no
// orchestrator, no LLM, mirrors the seo_audit direct-cycle pattern.
//
// Window sizes: GSC mutates for ~3 days after the fact and the freshest
// 1-2 days are partial, so we re-pull the last 5 days every run. GA4
// settles faster; 3 days is plenty. Upserts make the overlap free.

import { pool } from '../../memory/postgres'
import { getTenant } from '../../tenants/registry'
import { syncGscWindow } from '../../integrations/gsc/sync'
import { syncGa4Window } from '../../integrations/ga4/sync'
import { logger } from '../../logger'

const GSC_TRAILING_DAYS = 5
const GA4_TRAILING_DAYS = 3

function daysAgoISO(n: number): string {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

export interface MetricsSyncResult {
  gscRows: number | null   // null = integration not enabled / not configured
  ga4Rows: number | null
}

export async function runMetricsSyncCycle(tenantId: string): Promise<MetricsSyncResult> {
  const tenant = await getTenant(tenantId)
  const result: MetricsSyncResult = { gscRows: null, ga4Rows: null }

  const wantsGsc = tenant.integrations?.includes('gsc') && !!tenant.gsc_site_url
  const wantsGa4 = tenant.integrations?.includes('ga4') && !!tenant.ga4_property_id

  if (!wantsGsc && !wantsGa4) {
    logger.info('metrics_sync_nothing_to_do', {
      tenantId, hint: 'Neither gsc nor ga4 enabled+configured for this tenant.',
    })
    return result
  }

  if (wantsGsc) {
    try {
      const r = await syncGscWindow(pool, tenant, daysAgoISO(GSC_TRAILING_DAYS), daysAgoISO(1))
      result.gscRows = r.rows
    } catch (err) {
      logger.error('metrics_sync_gsc_failed', {
        tenantId, err: String(err).slice(0, 400),
        hint: 'Run: npm run google:check ' + tenantId,
      })
    }
  }

  if (wantsGa4) {
    try {
      const r = await syncGa4Window(pool, tenant, daysAgoISO(GA4_TRAILING_DAYS), daysAgoISO(1))
      result.ga4Rows = r.rows
    } catch (err) {
      logger.error('metrics_sync_ga4_failed', {
        tenantId, err: String(err).slice(0, 400),
        hint: 'Run: npm run google:check ' + tenantId,
      })
    }
  }

  logger.info('metrics_sync_cycle_done', { tenantId, ...result })
  return result
}
