// db/migrations/strategy-layer.ts
//
// Phase 2, build unit 2: the strategy layer.
//
//   seo_strategy            — per-tenant, versioned strategy doc. `core` JSONB
//                             holds the machine-read structured core (portfolio,
//                             competitive fronts, constraints); `brief` is the
//                             LLM/human-read prose. One row per refresh; latest
//                             version wins.
//   seo_clusters additions  — disposition (defend/grow/attack/seed/ignore) and
//                             priority, written by the strategy refresh and read
//                             by discovery (unit 3) for scope + cluster-fit.
//
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runStrategyLayerMigration(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo_strategy (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id    TEXT NOT NULL,
      version      INT  NOT NULL,
      core         JSONB NOT NULL,
      brief        TEXT,
      cold_start   BOOLEAN NOT NULL DEFAULT false,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, version)
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_strategy_tenant_version
      ON seo_strategy (tenant_id, version DESC)
  `)

  await pool.query(`
    ALTER TABLE seo_clusters
      ADD COLUMN IF NOT EXISTS disposition TEXT,
      ADD COLUMN IF NOT EXISTS priority    INT
  `)

  // disposition is nullable (legacy clusters) but constrained when present.
  await pool.query(`ALTER TABLE seo_clusters DROP CONSTRAINT IF EXISTS seo_clusters_disposition_check`)
  await pool.query(`
    ALTER TABLE seo_clusters
      ADD CONSTRAINT seo_clusters_disposition_check
      CHECK (disposition IS NULL OR disposition IN ('defend','grow','attack','seed','ignore'))
  `)
}
