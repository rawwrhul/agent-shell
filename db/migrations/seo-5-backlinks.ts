// db/migrations/seo-5-backlinks.ts
//
// SEO-5 Phase 1 schema. Creates:
//   - seo.backlink_inventory  — our inbound backlinks (active + lost)
//   - seo.brand_mentions      — SERP/web mentions of the brand
//   - seo.outreach_queue      — prospect rows linked to opportunities
//
// Plus a `tenants.disabled_opportunity_types` array so an operator can
// opt out of specific prospect types per-tenant without code changes.
//
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runSeo5BacklinksMigration(pool: Pool): Promise<void> {
  // ── Ensure the seo schema exists (created by SEO-2 migration but be safe) ─
  await pool.query(`CREATE SCHEMA IF NOT EXISTS seo`)

  // ── backlink_inventory ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo.backlink_inventory (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL,
      target_url      TEXT NOT NULL,
      source_url      TEXT NOT NULL,
      source_domain   TEXT NOT NULL,
      anchor_text     TEXT,
      source_dr       NUMERIC,
      source_da       NUMERIC,
      dofollow        BOOLEAN DEFAULT TRUE,
      first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status          TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','lost','toxic','pending_disavow')),
      UNIQUE (tenant_id, source_url, target_url)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_backlink_inventory_tenant
      ON seo.backlink_inventory (tenant_id, status, last_seen DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_backlink_inventory_source_domain
      ON seo.backlink_inventory (tenant_id, source_domain)
  `)

  // ── brand_mentions ────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo.brand_mentions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id       TEXT NOT NULL,
      source_url      TEXT NOT NULL,
      source_domain   TEXT NOT NULL,
      mention_context TEXT,
      has_backlink    BOOLEAN NOT NULL DEFAULT FALSE,
      detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status          TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','outreach_queued','linked','dismissed')),
      UNIQUE (tenant_id, source_url)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_brand_mentions_tenant
      ON seo.brand_mentions (tenant_id, status, detected_at DESC)
  `)

  // ── outreach_queue ────────────────────────────────────────────────────
  // One row per prospect attempt. Linked to seo_opportunities via opportunity_id.
  // For MVP: status flows queued → drafted → pending_approval → sent | dropped.
  // 'sent' is set when the operator approves (we trust them to actually send).
  // 'replied' tracking is manual (Phase 2 adds Slack button).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seo.outreach_queue (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id           TEXT NOT NULL,
      opportunity_id      UUID,
      prospect_type       TEXT NOT NULL
                          CHECK (prospect_type IN
                            ('backlink_gap','unlinked_mention','lost_backlink','haro','partnership')),
      target_site         TEXT NOT NULL,
      target_url_idea     TEXT,
      pitch_angle         TEXT,
      drafted_subject     TEXT,
      drafted_body        TEXT,
      contact_email       TEXT,
      status              TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN
                            ('queued','drafted','pending_approval','sent','dropped','replied')),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      drafted_at          TIMESTAMPTZ,
      sent_at             TIMESTAMPTZ,
      replied_at          TIMESTAMPTZ,
      response_summary    TEXT,
      last_outreach_at    TIMESTAMPTZ,
      UNIQUE (tenant_id, target_site)
    )
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outreach_queue_tenant_status
      ON seo.outreach_queue (tenant_id, status, created_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outreach_queue_opportunity
      ON seo.outreach_queue (opportunity_id)
      WHERE opportunity_id IS NOT NULL
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_outreach_queue_sent_today
      ON seo.outreach_queue (tenant_id, sent_at)
      WHERE sent_at IS NOT NULL
  `)

  // ── tenants.disabled_opportunity_types ────────────────────────────────
  // Array of type strings the tenant has opted out of. Discovery skills
  // honour this — they don't even file opportunities of disabled types.
  await pool.query(`
    ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS disabled_opportunity_types TEXT[]
        NOT NULL DEFAULT ARRAY[]::TEXT[]
  `)

  // ── seo_opportunities.detail JSONB ────────────────────────────────────
  // Rich type-specific payload for opportunities. SEO-5 stores drafted
  // email + recipient placeholder + mailto URL + prospect metadata here.
  // Future discovery skills can use this for their own payloads.
  await pool.query(`
    ALTER TABLE seo_opportunities
      ADD COLUMN IF NOT EXISTS detail JSONB
  `)
}
