-- 20260608-quoting-1-foundation.sql
--
-- Chunk 1 of the Quoting Agent (agentType 'quoting', client tenant: HD Level 2
-- Electrician). Adds the single state-of-record table for the quoting flow.
--
-- The Slack conversation is a *presenter over this row*, never the source of
-- truth — same discipline as slack_runs for the SEO presenter. A future
-- channel swap (Telegram) is therefore a presenter-layer change, not a
-- rewrite, because every stage payload lives here as JSONB.
--
-- State machine (mirrors quoting-agent-mvp-build-requirements.md §6):
--   LEAD_CAPTURED -> OUTLINE_POSTED -> SITE_PRIMED -> SITE_CAPTURED
--                 -> QUOTE_BUILT -> APPROVED -> SENT
--   terminal alternates: REJECTED, EXPIRED
--
-- Apply in the Supabase SQL editor (house rule: SQL never runs from the
-- terminal). Verified against db/migrate.ts: tenants(tenant_id) PK exists;
-- uuid-ossp + pgvector extensions are already created by the base migration.

BEGIN;

CREATE TABLE IF NOT EXISTS quotes (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),

  -- Lifecycle. CHECK keeps the column honest against the state machine; the
  -- TS state-machine module (src/agents/quoting/state-machine.ts) is the
  -- authority on *transitions*, this is the authority on *legal values*.
  state               TEXT NOT NULL DEFAULT 'LEAD_CAPTURED'
                        CHECK (state IN (
                          'LEAD_CAPTURED','OUTLINE_POSTED','SITE_PRIMED',
                          'SITE_CAPTURED','QUOTE_BUILT','APPROVED','SENT',
                          'REJECTED','EXPIRED'
                        )),

  -- Assigned when the final quote is built (QUOTE_BUILT). Null until then.
  quote_number        TEXT,

  -- Slack conversation handles. thread_ts is the anchor the whole quote
  -- conversation hangs off, so Stage 2 voice notes + the approval card land
  -- in one thread. Nullable so a quote can exist before its anchor is posted.
  slack_channel_id    TEXT,
  slack_thread_ts     TEXT,

  -- Denormalised for cheap listing / dashboards. Authoritative copies live
  -- inside the JSONB stage payloads below.
  customer_name       TEXT,
  customer_address    TEXT,
  customer_phone      TEXT,
  job_category        TEXT,
  job_subcategory     TEXT,

  -- Stage payloads. Each validated against its zod schema
  -- (src/agents/quoting/schemas.ts) before being written here.
  lead_intake         JSONB,   -- LeadIntake   (Stage 1 extraction)
  quote_outline       JSONB,   -- QuoteOutline (Stage 1 Slack dot points)
  site_checklist      JSONB,   -- SiteChecklist (issued at SITE_PRIMED)
  site_update         JSONB,   -- SiteUpdate   (Stage 2 extraction)
  quote_final         JSONB,   -- QuoteFinal   (the priced object == the PDF)

  -- Raw transcription audit trail: [{ stage, slackFileId, transcript,
  -- durationMs, createdAt }]. Kept so a mis-parse can be re-extracted
  -- without re-downloading the audio.
  transcripts         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The send gate. Links to the approval_requests row created in Chunk 5
  -- with tool_name='quote_send_email'. Soft link (no FK) to mirror the
  -- execution_jobs.approval_id convention and avoid cascade surprises.
  approval_id         UUID,

  -- Delivery artifacts (Chunk 5).
  pdf_gcs_uri         TEXT,
  pdf_filename        TEXT,
  sent_to             TEXT,    -- email the PDF was sent to (electrician in MVP)

  error               TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quotes_tenant_state
  ON quotes (tenant_id, state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_quotes_thread
  ON quotes (slack_channel_id, slack_thread_ts)
  WHERE slack_thread_ts IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_quotes_quote_number
  ON quotes (tenant_id, quote_number)
  WHERE quote_number IS NOT NULL;

COMMIT;
