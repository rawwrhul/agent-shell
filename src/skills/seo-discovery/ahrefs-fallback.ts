// src/skills/seo-discovery/ahrefs-fallback.ts
//
// Fallback ranking surface for tenants with an empty ranking_history
// (2026-07-17: hd-seo's GSC service-account grant was blocked for days —
// every ranking-driven discovery cycle scanned zero rows and the bank
// starved while the site plainly had rankings in Ahrefs).
//
// Shape-compatible with loadRankingRows: Ahrefs organic keywords for OUR
// domain mapped to RankingRow. Approximations, clearly understood:
//   impressions <- search volume  (demand proxy; GSC impressions unavailable)
//   clicks      <- 0              (unknown; makes every kw a CTR-gap candidate,
//                                  which is the correct bias when we know
//                                  nothing about actual CTR)
//   pos         <- best_position
// In-memory only — NEVER written to ranking_history, so real GSC data (and
// the outcome-scoring loop that depends on it) stays uncontaminated. The
// moment GSC rows exist, the fallback is never consulted.

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import { cachedJson } from '../../core/cache/cached-fetch'
import { organicKeywords } from '../../integrations/ahrefs/client'
import { mapAhrefsOrganicRows } from '../seo-keyword-gap/gap'
import { loadRankingRows } from './common'
import type { RankingRow } from './common'

const COUNTRY = 'au'
const LIMIT = 300
const MIN_VOLUME = 10
const CACHE_TTL_SECONDS = 7 * 24 * 3600   // weekly refresh while in fallback mode

/**
 * GSC-first loader for the optimisation cycles: real ranking_history when it
 * has rows, Ahrefs fallback when it's empty. Drop-in for loadRankingRows.
 */
export async function loadRankingRowsOrFallback(tenant: {
  tenantId: string
  targetDomain?: string | null
}): Promise<RankingRow[]> {
  const rows = await loadRankingRows(tenant.tenantId)
  if (rows.length > 0) return rows
  return loadAhrefsFallbackRows(tenant)
}

/** Pure mapper — unit-testable. */
export function ahrefsRowsToRankingRows(raw: unknown, minVolume = MIN_VOLUME): RankingRow[] {
  return mapAhrefsOrganicRows(raw)
    .filter((r) => r.url && r.volume >= minVolume)
    .map((r) => ({
      pageUrl:     r.url as string,
      keyword:     r.keyword,
      clicks:      0,
      impressions: r.volume,
      pos:         r.position,
    }))
}

/**
 * Load the Ahrefs fallback surface for a tenant. Best-effort: returns []
 * on any failure (no Ahrefs key, no domain, vendor error) so callers can
 * proceed with an empty surface exactly as before.
 */
export async function loadAhrefsFallbackRows(tenant: {
  tenantId: string
  targetDomain?: string | null
}): Promise<RankingRow[]> {
  const domain = (tenant.targetDomain ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!domain) return []
  try {
    const { value } = await cachedJson<unknown>({
      pool, source: 'ahrefs_organic_keywords', key: `own:${domain}:${COUNTRY}:${LIMIT}`,
      tenantId: tenant.tenantId, ttlSeconds: CACHE_TTL_SECONDS,
      fetcher: () => organicKeywords(domain, 'subdomains', COUNTRY, LIMIT),
    })
    const rows = ahrefsRowsToRankingRows(value)
    logger.warn('ranking_rows_ahrefs_fallback', {
      tenantId: tenant.tenantId, rows: rows.length,
      hint: 'ranking_history is EMPTY for this tenant — discovery is running on Ahrefs data. Fix GSC sync; this fallback has no real impressions/clicks.',
    })
    return rows
  } catch (err) {
    logger.warn('ahrefs_fallback_failed', { tenantId: tenant.tenantId, err: String(err).slice(0, 200) })
    return []
  }
}
