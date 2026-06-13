// src/integrations/ga4/sync.ts
//
// Pull GA4 page-level traffic for a date window into traffic_history.
// Idempotent: ON CONFLICT upsert against (tenant_id, date, page_url,
// source_medium). Paginates via offset.
//
// Metric notes: 'keyEvents' is GA4's current name for what used to be
// 'conversions' — stored in the conversions column.

import { Pool } from 'pg'
import { runReport } from './client'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

const PAGE_SIZE = 10_000
const MAX_PAGES = 20

export async function syncGa4Window(
  pool:    Pool,
  tenant:  TenantConfig,
  startDate: string,
  endDate:   string,
): Promise<{ rows: number; pages: number }> {
  let offset = 0
  let pages  = 0
  let total  = 0

  for (;;) {
    const res = await runReport(tenant, {
      startDate, endDate,
      dimensions: ['date', 'pagePath', 'sessionSourceMedium'],
      metrics:    ['sessions', 'keyEvents', 'bounceRate'],
      limit:      PAGE_SIZE,
      // BetaAnalyticsDataClient accepts offset alongside limit.
      ...( { offset } as Record<string, unknown> ),
    })
    pages++

    if (res.rows.length > 0) {
      for (let i = 0; i < res.rows.length; i += 500) {
        const chunk = res.rows.slice(i, i + 500)
        const values: unknown[] = []
        const tuples: string[]  = []
        chunk.forEach((r, j) => {
          const base = j * 7
          tuples.push(`($${base+1},to_date($${base+2},'YYYYMMDD'),$${base+3},$${base+4},$${base+5},$${base+6},$${base+7})`)
          values.push(
            tenant.tenantId,
            String(r.dimensionValues[0]),       // GA4 returns date as YYYYMMDD
            r.dimensionValues[1],
            r.dimensionValues[2],
            Math.round(Number(r.metricValues[0]) || 0),
            Math.round(Number(r.metricValues[1]) || 0),
            Number(r.metricValues[2]) || null,
          )
        })
        await pool.query(
          `INSERT INTO traffic_history
             (tenant_id, date, page_url, source_medium, sessions, conversions, bounce_rate)
           VALUES ${tuples.join(',')}
           ON CONFLICT (tenant_id, date, page_url, source_medium) DO UPDATE SET
             sessions = EXCLUDED.sessions, conversions = EXCLUDED.conversions,
             bounce_rate = EXCLUDED.bounce_rate, synced_at = NOW()`,
          values,
        )
      }
      total += res.rows.length
    }

    if (res.rows.length < PAGE_SIZE || pages >= MAX_PAGES) break
    offset += PAGE_SIZE
  }

  logger.info('ga4_sync_window_done', {
    tenantId: tenant.tenantId, startDate, endDate, rows: total, pages,
  })
  return { rows: total, pages }
}
