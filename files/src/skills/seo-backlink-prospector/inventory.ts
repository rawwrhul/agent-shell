// src/skills/seo-backlink-prospector/inventory.ts
//
// Fetch the tenant's current inbound backlinks from DataForSEO and upsert
// them into seo.backlink_inventory. Idempotent — multiple cycles just
// refresh last_seen.
//
// Why we do this every cycle (not just once): backlinks come and go.
// last_seen lets us detect lost links by checking which rows haven't been
// refreshed in N cycles. Phase 2 will mark them as 'lost'.

import type { TenantConfig } from '../../tenants/types'
import { backlinksList } from '../../integrations/dataforseo/client'
import { logger } from '../../logger'
import { upsertInventoryRow } from './store'

export async function refreshOwnInventory(input: {
  tenant: TenantConfig
}): Promise<{ fetched: number; inserted: number }> {
  const target = input.tenant.targetDomain
  if (!target) {
    logger.warn('backlink_inventory_skip_no_domain', { tenantId: input.tenant.tenantId })
    return { fetched: 0, inserted: 0 }
  }

  let rows: Awaited<ReturnType<typeof backlinksList>>
  try {
    rows = await backlinksList(input.tenant, { target, limit: 500 })
  } catch (err) {
    logger.error('backlink_inventory_fetch_failed', {
      tenantId: input.tenant.tenantId,
      err:      String(err).slice(0, 300),
    })
    return { fetched: 0, inserted: 0 }
  }

  let inserted = 0
  for (const r of rows) {
    try {
      const { inserted: wasInserted } = await upsertInventoryRow({
        tenantId:  input.tenant.tenantId,
        targetUrl: r.target_url ?? target,
        row: {
          sourceUrl:    r.source_url,
          sourceDomain: r.source_domain,
          anchorText:   r.anchor ?? null,
          sourceDr:     r.source_rank ?? null,
          dofollow:     r.dofollow ?? true,
        },
      })
      if (wasInserted) inserted++
    } catch (err) {
      logger.warn('backlink_inventory_upsert_failed', {
        tenantId: input.tenant.tenantId,
        sourceUrl: r.source_url,
        err:      String(err).slice(0, 200),
      })
    }
  }

  return { fetched: rows.length, inserted }
}
