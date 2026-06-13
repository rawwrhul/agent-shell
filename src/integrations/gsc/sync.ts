// src/integrations/gsc/sync.ts
//
// Pull GSC search analytics for a date window into ranking_history.
// Idempotent: ON CONFLICT upsert against (tenant_id, date, keyword, page_url).
// Paginates via startRow until GSC returns fewer rows than the page size.
//
// GSC data is mutable for ~3 days after the fact (and very fresh days are
// partial) — callers should always re-pull a trailing window rather than
// only "yesterday".

import { Pool } from 'pg'
import { querySearchAnalytics } from './client'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

const PAGE_SIZE = 5_000          // GSC max is 25k; smaller pages keep memory flat
const MAX_PAGES = 50             // hard stop: 250k rows per window per tenant

export async function syncGscWindow(
  pool:    Pool,
  tenant:  TenantConfig,
  startDate: string,             // 'YYYY-MM-DD'
  endDate:   string,             // 'YYYY-MM-DD'
): Promise<{ rows: number; pages: number }> {
  let startRow = 0
  let pages    = 0
  let total    = 0

  for (;;) {
    const rows = await querySearchAnalytics(tenant, {
      startDate, endDate,
      dimensions: ['date', 'query', 'page'],
      rowLimit:   PAGE_SIZE,
      startRow,
    })
    pages++

    if (rows.length > 0) {
      // Multi-row insert in chunks to keep statements bounded.
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500)
        const values: unknown[] = []
        const tuples: string[]  = []
        chunk.forEach((r, j) => {
          const base = j * 8
          tuples.push(`($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`)
          values.push(
            tenant.tenantId, r.keys[0], r.keys[1], r.keys[2],
            r.position, r.ctr, r.impressions, r.clicks,
          )
        })
        await pool.query(
          `INSERT INTO ranking_history
             (tenant_id, date, keyword, page_url, position, ctr, impressions, clicks)
           VALUES ${tuples.join(',')}
           ON CONFLICT (tenant_id, date, keyword, page_url) DO UPDATE SET
             position = EXCLUDED.position, ctr = EXCLUDED.ctr,
             impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
             synced_at = NOW()`,
          values,
        )
      }
      total += rows.length
    }

    if (rows.length < PAGE_SIZE || pages >= MAX_PAGES) break
    startRow += PAGE_SIZE
  }

  logger.info('gsc_sync_window_done', {
    tenantId: tenant.tenantId, startDate, endDate, rows: total, pages,
  })
  return { rows: total, pages }
}
