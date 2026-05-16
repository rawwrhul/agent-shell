// db/migrations/seo-1-crawler.ts
//
// SEO-1 Crawler tables — runs the same SQL as sql/20260516-seo-1-crawler.sql
// in a single transaction. Idempotent.

import type { Pool } from 'pg'

export async function runSeo1CrawlerMigration(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // seo_crawl_runs
    await client.query(`
      CREATE TABLE IF NOT EXISTS seo_crawl_runs (
        id              UUID PRIMARY KEY,
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
        crawl_kind      TEXT NOT NULL CHECK (crawl_kind IN ('full','delta','targeted')),
        seed_urls       TEXT[] NOT NULL DEFAULT '{}',
        status          TEXT NOT NULL CHECK (status IN
                          ('queued','in_progress','completed','failed','cancelled')),
        pages_crawled   INTEGER NOT NULL DEFAULT 0,
        pages_failed    INTEGER NOT NULL DEFAULT 0,
        pages_skipped   INTEGER NOT NULL DEFAULT 0,
        max_pages       INTEGER NOT NULL,
        max_depth       INTEGER NOT NULL,
        user_agent      TEXT NOT NULL,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ,
        error           TEXT,
        metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
      )`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_crawl_runs_tenant_started
        ON seo_crawl_runs (tenant_id, started_at DESC)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_crawl_runs_status
        ON seo_crawl_runs (status)
        WHERE status IN ('queued','in_progress')`)

    // seo_page_inventory
    await client.query(`
      CREATE TABLE IF NOT EXISTS seo_page_inventory (
        tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),
        url                 TEXT NOT NULL,
        last_crawl_run_id   UUID REFERENCES seo_crawl_runs(id),
        last_crawled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        http_status         INTEGER,
        final_url           TEXT,
        content_type        TEXT,
        content_hash        TEXT,
        word_count          INTEGER,
        title               TEXT,
        title_length        INTEGER,
        meta_description    TEXT,
        meta_desc_length    INTEGER,
        meta_robots         TEXT,
        canonical_url       TEXT,
        h1_count            INTEGER,
        h1_first            TEXT,
        schema_types        TEXT[] NOT NULL DEFAULT '{}',
        og_image            TEXT,
        language            TEXT,
        internal_links_out  INTEGER NOT NULL DEFAULT 0,
        external_links_out  INTEGER NOT NULL DEFAULT 0,
        image_count         INTEGER NOT NULL DEFAULT 0,
        images_with_alt     INTEGER NOT NULL DEFAULT 0,
        images_missing_alt  INTEGER NOT NULL DEFAULT 0,
        target_cluster_id   UUID,
        blob_gcs_uri        TEXT,
        fetch_error         TEXT,
        PRIMARY KEY (tenant_id, url)
      )`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_page_inventory_tenant_crawled
        ON seo_page_inventory (tenant_id, last_crawled_at DESC)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_page_inventory_tenant_status
        ON seo_page_inventory (tenant_id, http_status)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_page_inventory_hash
        ON seo_page_inventory (tenant_id, content_hash)`)

    // seo_internal_links
    await client.query(`
      CREATE TABLE IF NOT EXISTS seo_internal_links (
        tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
        source_url      TEXT NOT NULL,
        target_url      TEXT NOT NULL,
        anchor_text     TEXT NOT NULL DEFAULT '',
        rel             TEXT,
        is_nav          BOOLEAN NOT NULL DEFAULT false,
        position_index  INTEGER NOT NULL DEFAULT 0,
        last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (tenant_id, source_url, target_url, anchor_text)
      )`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_internal_links_target
        ON seo_internal_links (tenant_id, target_url)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_internal_links_source
        ON seo_internal_links (tenant_id, source_url)`)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_seo_internal_links_target_content
        ON seo_internal_links (tenant_id, target_url)
        WHERE is_nav = false`)

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
