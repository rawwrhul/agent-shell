-- db/migrations/002-seo-tables.sql
--
-- Rollout 2: state tables backing the daily run and weekly audit reports.
--
-- Run via the project's existing migration runner. Idempotent — safe to
-- re-run; uses CREATE ... IF NOT EXISTS throughout. The Rollout 1
-- migration created `slack_runs`; this one is purely additive.

-- ── seo_work_log ────────────────────────────────────────────────────
-- Every action the agent takes (or attempts) is logged here. The daily
-- report reads "shipped since last run" from this table.

CREATE TABLE IF NOT EXISTS seo_work_log (
  id            UUID PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  run_id        UUID NOT NULL,
  action_type   TEXT NOT NULL,
  target_url    TEXT,
  summary       TEXT NOT NULL,
  detail        TEXT,
  status        TEXT NOT NULL CHECK (status IN
                  ('success','partial','failed','awaiting_approval','queued')),
  executed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seo_work_log_tenant_executed
  ON seo_work_log (tenant_id, executed_at DESC);

CREATE INDEX IF NOT EXISTS idx_seo_work_log_run
  ON seo_work_log (run_id);

CREATE INDEX IF NOT EXISTS idx_seo_work_log_tenant_status
  ON seo_work_log (tenant_id, status)
  WHERE status IN ('awaiting_approval', 'queued');

-- ── seo_opportunities ───────────────────────────────────────────────
-- Opportunities surfaced by audits or runs. Some get queued and executed,
-- others become P2 backlog. The daily report shows opportunities surfaced
-- in the current run; the weekly audit aggregates by priority.

CREATE TABLE IF NOT EXISTS seo_opportunities (
  id                UUID PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  run_id            UUID NOT NULL,
  type              TEXT NOT NULL,
  target            TEXT,
  description       TEXT NOT NULL,
  rationale         TEXT,
  priority          TEXT NOT NULL CHECK (priority IN ('P0','P1','P2')),
  status            TEXT NOT NULL CHECK (status IN
                      ('new','queued','in_progress','executed','rejected','stale')),
  estimated_impact  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_run_id   UUID
);

CREATE INDEX IF NOT EXISTS idx_seo_opportunities_tenant_status
  ON seo_opportunities (tenant_id, status, priority);

CREATE INDEX IF NOT EXISTS idx_seo_opportunities_run
  ON seo_opportunities (run_id);

-- ── seo_metrics_snapshots ───────────────────────────────────────────
-- Periodic captures of the site's high-level health metrics. Drives the
-- weekly audit's state-of-play scorecard and week-over-week deltas.

CREATE TABLE IF NOT EXISTS seo_metrics_snapshots (
  id                       UUID PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  captured_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indexed_pages            INT,
  ranking_keywords         INT,
  schema_coverage_pct      NUMERIC(5,2),    -- 0.00 to 100.00
  avg_position             NUMERIC(6,2),
  ai_citations_estimated   INT,
  domain_rating            INT,
  raw_sources              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_seo_metrics_snapshots_tenant_captured
  ON seo_metrics_snapshots (tenant_id, captured_at DESC);

-- ── seo_clusters ────────────────────────────────────────────────────
-- Pillar-and-cluster tracking. One row per pillar topic per tenant.
-- Drives the "Cluster progress" section of the weekly audit.

CREATE TABLE IF NOT EXISTS seo_clusters (
  id                  UUID PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  pillar_topic        TEXT NOT NULL,
  pillar_url          TEXT,
  state               TEXT NOT NULL CHECK (state IN
                        ('planned','in_progress','complete','paused')),
  briefs_total        INT NOT NULL DEFAULT 0,
  briefs_drafted      INT NOT NULL DEFAULT 0,
  briefs_published    INT NOT NULL DEFAULT 0,
  awaiting_publish    INT NOT NULL DEFAULT 0,
  detail              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seo_clusters_tenant_topic_unique
    UNIQUE (tenant_id, pillar_topic)
);

CREATE INDEX IF NOT EXISTS idx_seo_clusters_tenant_state
  ON seo_clusters (tenant_id, state);

-- ── pgcrypto for gen_random_uuid() in upsertCluster ─────────────────
-- (gen_random_uuid is only needed in seo_clusters' upsert path. If the
-- extension is already enabled by Rollout 1 or by Supabase defaults,
-- this is a no-op.)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
