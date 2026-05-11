import { Pool } from 'pg'

export async function runR3Migration(pool: Pool): Promise<void> {
  await migrateTenantSchedules(pool)
  await migrateTenantsR3(pool)
  await migrateApprovalRequestsR3(pool)
}

async function migrateTenantSchedules(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_schedules (
      tenant_id     TEXT        NOT NULL REFERENCES tenants(tenant_id),
      run_kind      TEXT        NOT NULL,
      cron_expr     TEXT        NOT NULL,
      timezone      TEXT        NOT NULL DEFAULT 'Australia/Sydney',
      enabled       BOOLEAN     NOT NULL DEFAULT true,
      last_fired_at TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, run_kind),
      CHECK (run_kind IN ('daily', 'weekly'))
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_schedules_enabled
    ON tenant_schedules (enabled, run_kind) WHERE enabled = true
  `)
}

async function migrateTenantsR3(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS target_domain      TEXT,
      ADD COLUMN IF NOT EXISTS competitor_domains TEXT[],
      ADD COLUMN IF NOT EXISTS cron_timezone      TEXT,
      ADD COLUMN IF NOT EXISTS hitl_sheet_gid     INT
  `)
}

async function migrateApprovalRequestsR3(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS priority         TEXT        NOT NULL DEFAULT 'P1',
      ADD COLUMN IF NOT EXISTS proposed_action  TEXT,
      ADD COLUMN IF NOT EXISTS detail           JSONB       NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS why_priority     TEXT,
      ADD COLUMN IF NOT EXISTS slack_channel_id TEXT,
      ADD COLUMN IF NOT EXISTS slack_message_ts TEXT,
      ADD COLUMN IF NOT EXISTS sheet_row_number INT,
      ADD COLUMN IF NOT EXISTS defer_until      TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `)
  await pool.query(`
    ALTER TABLE approval_requests
      ALTER COLUMN session_id DROP NOT NULL
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_approval_tenant_status_requested
    ON approval_requests (tenant_id, status, requested_at)
    WHERE status = 'pending'
  `)
}