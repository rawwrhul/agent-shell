// db/migrations/google-ads.ts
//
// Google Ads vertical - `ads` schema, parallel to `seo`. Core foundational
// tables stay in `public` (agent_changes and artifact_snapshots are reused
// with kind discriminators; do NOT create ads-specific snapshot tables).
//
// Idempotent. Never narrow constraints over rows added after this runs.

import { Pool } from 'pg'

export async function runGoogleAdsMigration(pool: Pool): Promise<void> {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ads`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads.account_structure (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      customer_id    TEXT NOT NULL,
      campaign_id    BIGINT NOT NULL,
      campaign_name  TEXT NOT NULL,
      campaign_status TEXT NOT NULL,
      channel_type   TEXT,
      bidding_strategy_type TEXT,
      ad_group_id    BIGINT,
      ad_group_name  TEXT,
      ad_group_status TEXT,
      snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, campaign_id, ad_group_id, snapshot_at)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ads_structure_tenant
      ON ads.account_structure (tenant_id, snapshot_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads.performance_history (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      customer_id    TEXT NOT NULL,
      level          TEXT NOT NULL CHECK (level IN ('campaign', 'ad_group', 'keyword')),
      campaign_id    BIGINT NOT NULL,
      ad_group_id    BIGINT,
      criterion_id   BIGINT,
      date           DATE NOT NULL,
      impressions    BIGINT NOT NULL DEFAULT 0,
      clicks         BIGINT NOT NULL DEFAULT 0,
      cost_micros    BIGINT NOT NULL DEFAULT 0,
      conversions    DOUBLE PRECISION NOT NULL DEFAULT 0,
      conversions_value DOUBLE PRECISION NOT NULL DEFAULT 0,
      search_impression_share DOUBLE PRECISION,
      budget_lost_is DOUBLE PRECISION,
      rank_lost_is   DOUBLE PRECISION,
      recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, level, campaign_id, ad_group_id, criterion_id, date)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ads_perf_tenant_date
      ON ads.performance_history (tenant_id, date DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads.search_terms (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      customer_id    TEXT NOT NULL,
      campaign_id    BIGINT NOT NULL,
      ad_group_id    BIGINT NOT NULL,
      search_term    TEXT NOT NULL,
      date_range_start DATE NOT NULL,
      date_range_end   DATE NOT NULL,
      impressions    BIGINT NOT NULL DEFAULT 0,
      clicks         BIGINT NOT NULL DEFAULT 0,
      cost_micros    BIGINT NOT NULL DEFAULT 0,
      conversions    DOUBLE PRECISION NOT NULL DEFAULT 0,
      recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, campaign_id, ad_group_id, search_term, date_range_start, date_range_end)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ads_terms_mining
      ON ads.search_terms (tenant_id, cost_micros DESC, conversions)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ads.budget_state (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      TEXT NOT NULL,
      customer_id    TEXT NOT NULL,
      campaign_id    BIGINT NOT NULL,
      budget_id      BIGINT NOT NULL,
      amount_micros  BIGINT NOT NULL,
      spend_micros_30d BIGINT NOT NULL DEFAULT 0,
      budget_lost_is DOUBLE PRECISION,
      rank_lost_is   DOUBLE PRECISION,
      diagnosis      TEXT CHECK (diagnosis IN ('raise_budget', 'raise_bids', 'hold', 'review') OR diagnosis IS NULL),
      snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_id, campaign_id, snapshot_at)
    )`)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ads_budget_tenant
      ON ads.budget_state (tenant_id, snapshot_at DESC)`)

  console.log('  google-ads: ads schema ready (account_structure, performance_history, search_terms, budget_state)')
}
