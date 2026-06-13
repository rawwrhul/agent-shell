// src/core/strategy/store.ts
//
// Phase 2, build unit 2: persistence for the strategy layer. Owns:
//   - saveStrategyDoc       insert a new version (version = latest+1)
//   - getLatestStrategy     read the current doc for a tenant
//   - applyClusterDispositions  write portfolio dispositions back to seo_clusters

import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import { StrategyCore, StrategyDoc, PortfolioCluster } from './types'

/** Persist a new strategy version. Returns the version written. */
export async function saveStrategyDoc(input: {
  tenantId:  string
  core:      StrategyCore
  brief:     string
  coldStart: boolean
}): Promise<number> {
  const next = await pool.query<{ v: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM seo_strategy WHERE tenant_id = $1`,
    [input.tenantId],
  )
  const version = next.rows[0]?.v ?? 1
  await pool.query(
    `INSERT INTO seo_strategy (tenant_id, version, core, brief, cold_start, generated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, NOW())`,
    [input.tenantId, version, JSON.stringify(input.core), input.brief, input.coldStart],
  )
  logger.info('strategy_doc_saved', {
    tenantId: input.tenantId, version,
    clusters: input.core.portfolio.length,
    fronts:   input.core.fronts.length,
    coldStart: input.coldStart,
  })
  return version
}

/** Read the latest strategy doc for a tenant, or null if none yet. */
export async function getLatestStrategy(tenantId: string): Promise<StrategyDoc | null> {
  const res = await pool.query<{
    version: number; core: StrategyCore; brief: string | null;
    cold_start: boolean; generated_at: Date;
  }>(
    `SELECT version, core, brief, cold_start, generated_at
     FROM seo_strategy WHERE tenant_id = $1
     ORDER BY version DESC LIMIT 1`,
    [tenantId],
  )
  const row = res.rows[0]
  if (!row) return null
  return {
    tenantId,
    version:     row.version,
    core:        row.core,
    brief:       row.brief ?? '',
    coldStart:   row.cold_start,
    generatedAt: row.generated_at.toISOString(),
  }
}

/**
 * Write portfolio dispositions back to seo_clusters by matching pillar_topic
 * (case-insensitive). Only updates clusters that already exist — the strategy
 * doc names topics the cluster registry may not have rows for yet, and we do
 * not invent clusters here. Best-effort: a failure must never fail the cycle.
 */
export async function applyClusterDispositions(
  tenantId: string,
  portfolio: PortfolioCluster[],
): Promise<number> {
  let updated = 0
  for (const c of portfolio) {
    try {
      const res = await pool.query(
        `UPDATE seo_clusters
           SET disposition = $2, priority = $3, updated_at = NOW()
         WHERE tenant_id = $1 AND lower(pillar_topic) = lower($4)`,
        [tenantId, c.disposition, c.priority, c.topic],
      )
      updated += res.rowCount ?? 0
    } catch (err) {
      logger.warn('apply_cluster_disposition_failed', {
        tenantId, topic: c.topic, err: String(err).slice(0, 200),
      })
    }
  }
  return updated
}
