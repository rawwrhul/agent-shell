-- SEO skill tables: work log, opportunities backlog, metrics snapshots,
-- content clusters. Queried by reconciliation.ts and cron-context.ts.

-- ── seo_work_log ─────────────────────────────────────────────────────────────
-- Each row is an action executed by the executor worker after operator approval.
CREATE TABLE IF NOT EXISTS seo_work_log (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   TEXT        NOT NULL REFERENCES tenants(tenant_id),
  run_id      UUID        NOT NULL,
  action_type TEXT        NOT NULL,
  summary     TEXT        NOT NULL,
  url         TEXT,
  status      TEXT        NOT NULL DEFAULT 'success',
  metadata    JSONB       NOT NULL DEFAULT '{}',
  executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seo_work_log_tenant ON seo_work_log(tenant_id);
CREATE INDEX IF NOT EXISTS idx_seo_work_log_run    ON seo_work_log(run_id);

-- ── seo_opportunities ─────────────────────────────────────────────────────────
-- Backlog items surfaced by specialists via log_opportunity.
CREATE TABLE IF NOT EXISTS seo_opportunities (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        TEXT        NOT NULL REFERENCES tenants(tenant_id),
  run_id           UUID        NOT NULL,
  description      TEXT        NOT NULL,
  priority         TEXT        NOT NULL DEFAULT 'P2',
  url              TEXT,
  estimated_effort TEXT,
  status           TEXT        NOT NULL DEFAULT 'open',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seo_opp_tenant   ON seo_opportunities(tenant_id);
CREATE INDEX IF NOT EXISTS idx_seo_opp_priority ON seo_opportunities(priority);

-- ── seo_metrics_snapshots ─────────────────────────────────────────────────────
-- Point-in-time metric readings for weekly trend reporting.
CREATE TABLE IF NOT EXISTS seo_metrics_snapshots (
  id                      UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id               TEXT        NOT NULL REFERENCES tenants(tenant_id),
  indexed_pages           INTEGER,
  ranking_keywords        INTEGER,
  schema_coverage_pct     NUMERIC(5, 2),
  avg_position            NUMERIC(6, 2),
  ai_citations_estimated  INTEGER,
  domain_rating           NUMERIC(5, 2),
  notes                   TEXT,
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_seo_metrics_tenant ON seo_metrics_snapshots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_seo_metrics_time   ON seo_metrics_snapshots(captured_at);

-- ── seo_clusters ─────────────────────────────────────────────────────────────
-- Topical content cluster records. Upserted by upsert_cluster tool.
CREATE TABLE IF NOT EXISTS seo_clusters (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id        TEXT        NOT NULL REFERENCES tenants(tenant_id),
  pillar_topic     TEXT        NOT NULL,
  state            TEXT        NOT NULL DEFAULT 'planned',
  briefs_landed    INTEGER     NOT NULL DEFAULT 0,
  briefs_total     INTEGER     NOT NULL DEFAULT 0,
  awaiting_publish INTEGER     NOT NULL DEFAULT 0,
  detail           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, pillar_topic)
);
CREATE INDEX IF NOT EXISTS idx_seo_clusters_tenant ON seo_clusters(tenant_id);
