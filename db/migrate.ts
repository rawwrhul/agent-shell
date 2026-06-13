import { Pool } from 'pg'
import 'dotenv/config'
import { runR3Migration } from './migrations/r3-tenant-schedules-and-domain'
import { runPhase8Migration } from './migrations/phase8-two-stage-approval'
import { runSeo1CrawlerMigration } from './migrations/seo-1-crawler'
import { runSeo2AuditorMigration } from './migrations/seo-2-auditor'
import { runOpportunityBankMigration } from './migrations/opportunity-bank'
import { runSeo5BacklinksMigration }   from './migrations/seo-5-backlinks'
import { runBusinessBriefAndCardsMigration } from './migrations/business-brief-and-cards'
import { runVoyageEmbeddingsMigration } from './migrations/voyage-embeddings'
import { runSheetsRemovalMigration } from './migrations/sheets-removal'
import { runMetricsHistoryMigration } from './migrations/metrics-history'
import { runCacheEntriesMigration } from './migrations/cache-entries'
import { runOpportunityScoringMigration } from './migrations/opportunity-scoring'
import { runStrategyLayerMigration } from './migrations/strategy-layer'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

async function migrate() {
  console.log('Running CGS Agent Shell v3 migrations…')

  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await pool.query(`CREATE EXTENSION IF NOT EXISTS vector`)

  // ── Tenants ───────────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      tenant_id                   TEXT PRIMARY KEY,
      client_name                 TEXT NOT NULL,
      agent_type                  TEXT NOT NULL,
      agent_model                 TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      token_budget_per_run        INTEGER NOT NULL DEFAULT 100000,
      skills                      JSONB NOT NULL DEFAULT '[]',
      slack_channel_id            TEXT NOT NULL,
      hitl_sheet_name             TEXT NOT NULL DEFAULT 'Approvals',
      billing_tag                 TEXT NOT NULL,
      is_active                   BOOLEAN NOT NULL DEFAULT true,
      secret_slack_bot_token      TEXT NOT NULL,
      secret_slack_app_token      TEXT NOT NULL,
      secret_slack_signing_secret TEXT NOT NULL,
      secret_hitl_spreadsheet_id  TEXT NOT NULL,
      secret_google_sa_email      TEXT NOT NULL,
      secret_google_private_key   TEXT NOT NULL,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)

  // ── Run records ───────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_records (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
      task_id          TEXT NOT NULL,
      agent_type       TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ,
      token_count      INTEGER NOT NULL DEFAULT 0,
      tool_call_count  INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'running',
      summary          TEXT,
      error            TEXT
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_tenant  ON run_records(tenant_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_task    ON run_records(task_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_run_started ON run_records(started_at)`)

  // ── Subtasks (orchestration layer) ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subtasks (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      parent_task_id   TEXT NOT NULL,
      tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
      specialist_type  TEXT NOT NULL,
      specialist_name  TEXT NOT NULL,
      task             TEXT NOT NULL,
      context          TEXT NOT NULL DEFAULT '',
      skills           JSONB NOT NULL DEFAULT '[]',
      priority         INTEGER NOT NULL DEFAULT 5,
      status           TEXT NOT NULL DEFAULT 'pending',
      output           TEXT,
      summary          TEXT,
      token_count      INTEGER NOT NULL DEFAULT 0,
      tool_call_count  INTEGER NOT NULL DEFAULT 0,
      error            TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_subtask_parent ON subtasks(parent_task_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_subtask_tenant ON subtasks(tenant_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_subtask_status ON subtasks(status)`)

  // ── Semantic memory ───────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_learnings (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
      agent_type  TEXT NOT NULL,
      content     TEXT NOT NULL,
      embedding   vector(1536),
      metadata    JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_learn_tenant ON agent_learnings(tenant_id)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_learn_vec
    ON agent_learnings USING ivfflat (embedding vector_cosine_ops) WITH (lists=100)`)

  // ── HITL audit log ────────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tenant_id        TEXT NOT NULL REFERENCES tenants(tenant_id),
      task_id          TEXT NOT NULL,
      session_id       TEXT NOT NULL,
      tool_name        TEXT NOT NULL,
      tool_input       JSONB NOT NULL,
      risk_level       TEXT NOT NULL,
      risk_reason      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at      TIMESTAMPTZ,
      resolved_by      TEXT,
      rejection_reason TEXT
    )`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_tenant ON approval_requests(tenant_id)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status)`)

  // ── Slack run state (rollout 1: SlackPresenter) ───────────────────────────
  // One row per agent task. Holds the anchor message timestamp and a structured
  // RunState blob mutated under SELECT ... FOR UPDATE on every lifecycle event,
  // so concurrent specialist completions can't trample each other.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS slack_runs (
      task_id     TEXT        PRIMARY KEY,
      tenant_id   TEXT        NOT NULL REFERENCES tenants(tenant_id),
      channel_id  TEXT        NOT NULL,
      anchor_ts   TEXT        NOT NULL,
      state       JSONB       NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_slack_runs_tenant_updated
    ON slack_runs (tenant_id, updated_at DESC)`)

  // ──────────────────────────────────────────────────────────────────────────
  //  ROLLOUT 2 — block kit + new report shapes + memory layer
  // ──────────────────────────────────────────────────────────────────────────

  // ── seo_work_log (structured L2 — every action the agent takes) ───────────
  await pool.query(`
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
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_work_log_tenant_executed
    ON seo_work_log (tenant_id, executed_at DESC)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_work_log_run
    ON seo_work_log (run_id)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_work_log_tenant_status
    ON seo_work_log (tenant_id, status)
    WHERE status IN ('awaiting_approval', 'queued')`)

  // ── seo_opportunities (structured L2 — surfaced opportunities) ────────────
  await pool.query(`
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
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_opportunities_tenant_status
    ON seo_opportunities (tenant_id, status, priority)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_opportunities_run
    ON seo_opportunities (run_id)`)

  // ── seo_metrics_snapshots (structured L2 — weekly health metrics) ─────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo_metrics_snapshots (
      id                       UUID PRIMARY KEY,
      tenant_id                TEXT NOT NULL,
      captured_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      indexed_pages            INT,
      ranking_keywords         INT,
      schema_coverage_pct      NUMERIC(5,2),
      avg_position             NUMERIC(6,2),
      ai_citations_estimated   INT,
      domain_rating            INT,
      raw_sources              JSONB NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_metrics_snapshots_tenant_captured
    ON seo_metrics_snapshots (tenant_id, captured_at DESC)`)

  // ── seo_clusters (structured L2 — pillar/cluster tracking) ────────────────
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)
  await pool.query(`
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
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_seo_clusters_tenant_state
    ON seo_clusters (tenant_id, state)`)

  // ── tenant_memory (generic L2 — free-form per-tenant memory) ──────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_memory (
      id              UUID PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      type            TEXT NOT NULL CHECK (type IN
                        ('win','loss','in_progress','learning','decision',
                         'constraint','preference','fact')),
      key             TEXT NOT NULL,
      value           TEXT NOT NULL,
      confidence      NUMERIC(3,2) NOT NULL DEFAULT 0.50
                        CHECK (confidence >= 0 AND confidence <= 1),
      evidence_count  INT NOT NULL DEFAULT 1,
      source_run_id   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT tenant_memory_tenant_type_key_unique
        UNIQUE (tenant_id, type, key)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_memory_tenant_type_updated
    ON tenant_memory (tenant_id, type, updated_at DESC)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_memory_confident
    ON tenant_memory (tenant_id, type, updated_at DESC)
    WHERE confidence >= 0.25`)

  // Touch trigger: keep updated_at fresh on tenant_memory updates
  await pool.query(`
    CREATE OR REPLACE FUNCTION touch_tenant_memory_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`)
  await pool.query(`DROP TRIGGER IF EXISTS trg_tenant_memory_touch ON tenant_memory`)
  await pool.query(`
    CREATE TRIGGER trg_tenant_memory_touch
      BEFORE UPDATE ON tenant_memory
      FOR EACH ROW
      EXECUTE FUNCTION touch_tenant_memory_updated_at()`)

  // ── run_scratchpad (L1 — append-only working memory per run) ──────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS run_scratchpad (
      id          UUID PRIMARY KEY,
      run_id      UUID NOT NULL,
      key         TEXT NOT NULL,
      value       JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_run_scratchpad_run_created
    ON run_scratchpad (run_id, created_at ASC)`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_run_scratchpad_run_key
    ON run_scratchpad (run_id, key)`)

  await runR3Migration(pool)
  await runPhase8Migration(pool)
  await runSeo1CrawlerMigration(pool)
  await runSeo2AuditorMigration(pool)
  await runOpportunityBankMigration(pool)
  await runSeo5BacklinksMigration(pool)
  await runBusinessBriefAndCardsMigration(pool)
  await runVoyageEmbeddingsMigration(pool)
  await runSheetsRemovalMigration(pool)
  await runMetricsHistoryMigration(pool)
  await runCacheEntriesMigration(pool)
  await runOpportunityScoringMigration(pool)
  await runStrategyLayerMigration(pool)

  console.log('✅ All migrations complete')
  await pool.end()
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1) })
