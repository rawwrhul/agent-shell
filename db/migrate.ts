import { Pool } from 'pg'
import 'dotenv/config'

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

  console.log('✅ All migrations complete')
  await pool.end()
}

migrate().catch(err => { console.error('Migration failed:', err); process.exit(1) })
