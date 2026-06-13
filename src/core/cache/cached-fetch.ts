// src/core/cache/cached-fetch.ts
//
// Minimal read-through cache for unit-metered vendor APIs. Not the full
// CachedClient rollout — no visibility tiers, no stale-while-revalidate,
// no nightly eviction. Just: same question within TTL = no API spend.
//
// Tenant-scoped by default (roadmap decision: default to most private).
// Expired rows for the same source are deleted opportunistically on write,
// in bounded batches, so the table self-cleans without a cron.

import { Pool } from 'pg'
import { logger } from '../../logger'

export interface CachedJsonArgs<T> {
  pool:       Pool
  source:     string                 // 'ahrefs' | 'surfer' | ...
  key:        string                 // deterministic per query, e.g. 'backlinks:acme.com:25'
  tenantId:   string
  ttlSeconds: number
  fetcher:    () => Promise<T>
}

export async function cachedJson<T>(args: CachedJsonArgs<T>): Promise<{ value: T; cacheHit: boolean }> {
  const { pool, source, key, tenantId, ttlSeconds, fetcher } = args

  try {
    const hit = await pool.query(
      `SELECT payload FROM cache_entries
        WHERE source = $1 AND cache_key = $2 AND tenant_id = $3 AND expires_at > NOW()`,
      [source, key, tenantId],
    )
    if (hit.rows.length > 0) {
      logger.info('vendor_cache_hit', { source, key, tenantId })
      return { value: hit.rows[0].payload as T, cacheHit: true }
    }
  } catch (err) {
    // Cache read failure must never block the actual fetch.
    logger.warn('vendor_cache_read_failed', { source, key, err: String(err).slice(0, 200) })
  }

  const value = await fetcher()

  try {
    await pool.query(
      `INSERT INTO cache_entries (source, cache_key, tenant_id, payload, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)
       ON CONFLICT (source, cache_key, tenant_id) DO UPDATE SET
         payload = EXCLUDED.payload, captured_at = NOW(), expires_at = EXCLUDED.expires_at`,
      [source, key, tenantId, JSON.stringify(value), String(ttlSeconds)],
    )
    // Opportunistic bounded eviction for this source.
    await pool.query(
      `DELETE FROM cache_entries WHERE ctid IN (
         SELECT ctid FROM cache_entries
          WHERE source = $1 AND expires_at < NOW() LIMIT 200)`,
      [source],
    )
  } catch (err) {
    logger.warn('vendor_cache_write_failed', { source, key, err: String(err).slice(0, 200) })
  }

  return { value, cacheHit: false }
}

/** Standard TTLs (roadmap rollout-5 values). */
export const TTL = {
  DOMAIN_RATING:    7  * 86_400,
  BACKLINKS:        14 * 86_400,
  REF_DOMAINS:      14 * 86_400,
  ORGANIC_KEYWORDS: 30 * 86_400,
  KEYWORD_METRICS:  30 * 86_400,
  SURFER_GUIDELINES: 30 * 86_400,
  SERP_OVERVIEW:     3  * 86_400,
} as const
