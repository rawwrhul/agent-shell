-- 20260512-integrations-and-executions.sql
-- Adds:
--   1) integration_credentials: per-tenant encrypted API keys for Framer + DataForSEO
--   2) execution_jobs: persistent record of approved actions being executed by the
--      execution worker. BullMQ holds the live job queue; this table is the durable
--      log + state tracker the agent + UI can read.
--   3) tenant columns for integrations (enabled list, GSC site URL, GA4 property
--      ID, Framer project URL).

BEGIN;

-- ── Per-tenant encrypted credentials ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS integration_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  integration     text NOT NULL,        -- 'framer' | 'dataforseo'
  encrypted_blob  bytea NOT NULL,       -- AES-256-GCM: [12-byte IV][16-byte TAG][N-byte CT]
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- non-secret context, e.g. account_id, login
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT integration_credentials_uniq UNIQUE (tenant_id, integration)
);

CREATE INDEX IF NOT EXISTS idx_integration_credentials_tenant ON integration_credentials (tenant_id);

-- ── Execution jobs (persistent record of approved-action dispatch) ──────────

CREATE TABLE IF NOT EXISTS execution_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     text NOT NULL,
  approval_id   uuid NOT NULL,                   -- references approval_requests.id (FK is soft to avoid cascade surprises)
  task_id       text NOT NULL,
  tool_name     text NOT NULL,                   -- e.g. 'framer_update_page_seo', 'gsc_request_indexing'
  tool_input    jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued',  -- queued | running | success | failed | skipped
  attempts      integer NOT NULL DEFAULT 0,
  result        jsonb,                           -- handler output on success
  error         text,                            -- error message on failure
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  completed_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_execution_jobs_status_enqueued ON execution_jobs (status, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_execution_jobs_approval ON execution_jobs (approval_id);
CREATE INDEX IF NOT EXISTS idx_execution_jobs_tenant ON execution_jobs (tenant_id);

-- ── Tenant config extensions ────────────────────────────────────────────────

-- Integrations enabled (separate concern from skills; an SEO-skill tenant may
-- have 0 integrations connected at launch and gradually grow them).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS integrations jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Property identifiers for Google integrations (non-secret — no encryption needed).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS gsc_site_url text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ga4_property_id text;

-- Framer project URL (the API key sits in integration_credentials encrypted).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS framer_project_url text;

COMMIT;
