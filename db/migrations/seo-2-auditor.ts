// db/migrations/seo-2-auditor.ts
//
// SEO-2 Technical Auditor migration. Adds seo_audit_runs, seo_audit_findings,
// extends seo_opportunities with source_finding_id, and extends the
// tenant_schedules run_kind CHECK to include 'seo_audit'. Idempotent.

import type { Pool } from 'pg'

export async function runSeo2AuditorMigration(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // seo_audit_runs
    await client.query(`
      CREATE TABLE IF NOT EXISTS seo_audit_runs (
        id                    UUID PRIMARY KEY,
        tenant_id             TEXT NOT NULL REFERENCES tenants(tenant_id),
        crawl_run_id          UUID REFERENCES seo_crawl_runs(id),
        status                TEXT NOT NULL CHECK (status IN ('in_progress','completed','failed')),
        started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at          TIMESTAMPTZ,
        findings_total        INTEGER NOT NULL DEFAULT 0,
        findings_new          INTEGER NOT NULL DEFAULT 0,
        findings_persistent   INTEGER NOT NULL DEFAULT 0,
        findings_resolved     INTEGER NOT NULL DEFAULT 0,
        opportunities_created INTEGER NOT NULL DEFAULT 0,
        narrative             TEXT,
        error                 TEXT,
        metadata              JSONB NOT NULL DEFAULT '{}'::jsonb
      )`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_audit_runs_tenant_started
        ON seo_audit_runs (tenant_id, started_at DESC)`)

    // seo_audit_findings
    await client.query(`
      CREATE TABLE IF NOT EXISTS seo_audit_findings (
        id              UUID PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
        audit_run_id    UUID NOT NULL REFERENCES seo_audit_runs(id),
        check_name      TEXT NOT NULL,
        finding_key     TEXT NOT NULL,
        target_url      TEXT,
        related_url     TEXT,
        severity        TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
        state           TEXT NOT NULL CHECK (state IN ('new','persistent','resolved','ignored')),
        first_seen_at   TIMESTAMPTZ NOT NULL,
        last_seen_at    TIMESTAMPTZ NOT NULL,
        weeks_open      INTEGER NOT NULL DEFAULT 1,
        detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
        opportunity_id  UUID,
        ignored_reason  TEXT,
        UNIQUE (tenant_id, finding_key)
      )`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_audit_findings_tenant_state
        ON seo_audit_findings (tenant_id, state, severity)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_audit_findings_audit_run
        ON seo_audit_findings (audit_run_id)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_audit_findings_check_state
        ON seo_audit_findings (tenant_id, check_name, state)
        WHERE state IN ('new','persistent')`)

    // seo_opportunities extension
    await client.query(`
      ALTER TABLE seo_opportunities
        ADD COLUMN IF NOT EXISTS source_finding_id UUID REFERENCES seo_audit_findings(id)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_opportunities_source_finding
        ON seo_opportunities (source_finding_id)
        WHERE source_finding_id IS NOT NULL`)

    // tenant_schedules run_kind extension. Drop the existing CHECK if present
    // (its name varies depending on PG version + creation order), then re-add
    // with the extended allowed-values list.
    await client.query(`
      DO $$
      DECLARE
        cn TEXT;
      BEGIN
        FOR cn IN
          SELECT conname FROM pg_constraint
            WHERE conrelid = 'tenant_schedules'::regclass
              AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%run_kind%'
        LOOP
          EXECUTE 'ALTER TABLE tenant_schedules DROP CONSTRAINT ' || quote_ident(cn);
        END LOOP;
      END$$`)
    // Constraint ownership moved to db/migrations/metrics-history.ts
    // (2026-06-13). This migration used to recreate the CHECK with its
    // era's run_kind list, which broke re-runs once later kinds
    // (backlink_prospect, brand_mention_scan, metrics_sync, strategy_refresh,
    // and the Phase 2 content kinds) had rows in the table — idempotent
    // migrations must never narrow constraints over data added after them.
    // We DROP any stale CHECK above and stop here; runMetricsHistoryMigration
    // (which runs after this one) recreates it as the single canonical owner
    // with the complete run_kind list.

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
