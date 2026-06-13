// src/skills/seo-discovery/conversion-rate.ts
//
// Phase 2, unit 3: resolves the effective per-page conversion rate used to
// score in conversions (decision 3 + the page→tenant fallback).
//
// Rule: use the page's own rate ONLY when it has enough conversions to be
// trustworthy (>= MIN_CONVERSIONS); otherwise the tenant-wide rate. This
// avoids two failure modes — mixing conversion-scale and click-scale numbers
// in one bank, and zeroing out pages that simply haven't converted enough yet
// to estimate (50 sessions / 0 conversions is "unmeasured", not "0%").
//
// Returns null only when the tenant has no conversion signal at all, which the
// scorer reads as "score this tenant in clicks".

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'

const WINDOW_DAYS = 90
const MIN_CONVERSIONS = 5

export interface ConversionRateResolver {
  /** Tenant-wide conversions/sessions, or null if no sessions at all. */
  tenantRate(): number | null
  /** Effective rate for a page (page rate if trustworthy, else tenant rate). */
  rateFor(pageUrl: string): Promise<number | null>
}

export async function buildConversionRateResolver(tenantId: string): Promise<ConversionRateResolver> {
  let tenantRateValue: number | null = null
  try {
    const res = await pool.query<{ conv: string; sess: string }>(
      `SELECT COALESCE(SUM(conversions),0) conv, COALESCE(SUM(sessions),0) sess
       FROM traffic_history
       WHERE tenant_id=$1 AND date >= CURRENT_DATE - $2::int`,
      [tenantId, WINDOW_DAYS],
    )
    const conv = Number(res.rows[0]?.conv ?? 0)
    const sess = Number(res.rows[0]?.sess ?? 0)
    tenantRateValue = sess > 0 ? conv / sess : null
  } catch (err) {
    logger.warn('conversion_rate_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
  }

  const cache = new Map<string, number | null>()

  const rateFor = async (pageUrl: string): Promise<number | null> => {
    if (cache.has(pageUrl)) return cache.get(pageUrl) ?? null
    let rate: number | null = tenantRateValue
    try {
      const res = await pool.query<{ conv: string; sess: string }>(
        `SELECT COALESCE(SUM(conversions),0) conv, COALESCE(SUM(sessions),0) sess
         FROM traffic_history
         WHERE tenant_id=$1 AND page_url=$2 AND date >= CURRENT_DATE - $3::int`,
        [tenantId, pageUrl, WINDOW_DAYS],
      )
      const conv = Number(res.rows[0]?.conv ?? 0)
      const sess = Number(res.rows[0]?.sess ?? 0)
      if (conv >= MIN_CONVERSIONS && sess > 0) rate = conv / sess
    } catch (err) {
      logger.warn('conversion_rate_page_load_failed', { tenantId, pageUrl, err: String(err).slice(0, 150) })
    }
    cache.set(pageUrl, rate)
    return rate
  }

  return { tenantRate: () => tenantRateValue, rateFor }
}
