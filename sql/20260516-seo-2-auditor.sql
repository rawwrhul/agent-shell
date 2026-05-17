-- sql/20260516-seo-2-auditor.sql
--
-- SEO Rollout 2 — Technical SEO Auditor.
--
-- Adds two tables (seo_audit_runs, seo_audit_findings) and one column
-- extension (seo_opportunities.source_finding_id). Idempotent — safe to
-- re-run.
--
-- Architectural notes:
--   - Findings have a stable `finding_key` per check + target so we can
--     match findings across audits to compute new/persistent/resolved.
--   - `weeks_open` tracks how long a persistent finding has been around.
--     Audits running more often than weekly still increment by 1 per audit;
--     the unit is "audits" rather than literal weeks, but the field is
--     named for clarity in operator-facing output.
--   - findings → opportunities mapping is many-to-one. Multiple findings
--     of the same kind (e.g. 24 duplicate_titles) collapse into a single
--     opportunity by the synthesis layer.

BEGIN;

-- ── seo_audit_runs ─────────────────────────────────────────────────────────
-- One row per audit pass.

CREATE TABLE IF NOT EXISTS seo_audit_runs (
  id                  UUID PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),
  crawl_run_id        UUID REFERENCES seo_crawl_runs(id),  -- which crawl this audit ran against
  status              TEXT NOT NULL CHECK (status IN
                        ('in_progress','completed','failed')),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  findings_total      INTEGER NOT NULL DEFAULT 0,
  findings_new        INTEGER NOT NULL DEFAULT 0,
  findings_persistent INTEGER NOT NULL DEFAULT 0,
  findings_resolved   INTEGER NOT NULL DEFAULT 0,
  opportunities_created INTEGER NOT NULL DEFAULT 0,
  narrative           TEXT,    -- LLM-generated audit summary written into tenant_memory
  error               TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_seo_audit_runs_tenant_started
  ON seo_audit_runs (tenant_id, started_at DESC);

-- ── seo_audit_findings ─────────────────────────────────────────────────────
-- Every finding produced by every check, with state tracking across audits.

CREATE TABLE IF NOT EXISTS seo_audit_findings (
  id              UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  audit_run_id    UUID NOT NULL REFERENCES seo_audit_runs(id),
  check_name      TEXT NOT NULL,            -- e.g. 'broken_internal_link', 'orphan_page'
  finding_key     TEXT NOT NULL,            -- stable across audits, e.g.
                                            -- 'broken_internal_link::/about::/our-story'
  target_url      TEXT,                     -- page the finding is "about"
  related_url     TEXT,                     -- e.g. broken target, conflicting canonical
  severity        TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  state           TEXT NOT NULL CHECK (state IN ('new','persistent','resolved','ignored')),
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  weeks_open      INTEGER NOT NULL DEFAULT 1,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  opportunity_id  UUID,                     -- set when synthesis creates an opportunity from this finding
  ignored_reason  TEXT,                     -- operator-set, persists across audits
  -- A finding_key is unique per tenant — the same logical issue persists
  -- across audits as one row whose state + last_seen_at + weeks_open get
  -- updated each audit.
  UNIQUE (tenant_id, finding_key)
);

CREATE INDEX IF NOT EXISTS idx_seo_audit_findings_tenant_state
  ON seo_audit_findings (tenant_id, state, severity);

CREATE INDEX IF NOT EXISTS idx_seo_audit_findings_audit_run
  ON seo_audit_findings (audit_run_id);

CREATE INDEX IF NOT EXISTS idx_seo_audit_findings_check_state
  ON seo_audit_findings (tenant_id, check_name, state)
  WHERE state IN ('new','persistent');

-- ── seo_opportunities extension ────────────────────────────────────────────
-- Add a back-reference so every audit-generated opportunity traces back
-- to the deterministic finding that produced it. Existing opportunities
-- (from other code paths) keep source_finding_id NULL.

ALTER TABLE seo_opportunities
  ADD COLUMN IF NOT EXISTS source_finding_id UUID REFERENCES seo_audit_findings(id);

CREATE INDEX IF NOT EXISTS idx_seo_opportunities_source_finding
  ON seo_opportunities (source_finding_id)
  WHERE source_finding_id IS NOT NULL;

-- ── tenant_schedules extension ─────────────────────────────────────────────
-- The existing run_kind CHECK constraint allows 'daily','weekly','end-of-week'.
-- Extend to allow 'seo_audit'. Done via constraint drop + re-add (idempotent
-- because we re-add only after dropping).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
     WHERE table_name = 'tenant_schedules' AND constraint_name LIKE '%run_kind%'
  ) THEN
    ALTER TABLE tenant_schedules DROP CONSTRAINT IF EXISTS tenant_schedules_run_kind_check;
  END IF;
END$$;

ALTER TABLE tenant_schedules
  ADD CONSTRAINT tenant_schedules_run_kind_check
  CHECK (run_kind IN ('daily','weekly','end-of-week','seo_audit'));

COMMIT;
