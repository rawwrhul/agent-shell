-- sql/20260516-seo-1-crawler.sql
--
-- SEO Rollout 1 — Crawler & Fetcher infrastructure.
--
-- Three tables, all in public schema with seo_ prefix to match current
-- practice (seo_work_log, seo_opportunities, seo_metrics_snapshots,
-- seo_clusters). All idempotent — safe to re-run.
--
-- These tables are consumed by:
--   - The cron-triggered crawler (writes)
--   - Future seo-technical-auditor specialist (reads)
--   - Future seo-competitor-tracker specialist (writes competitor data with
--     a different tenant_id namespacing — TBD in SEO-4)
--   - Agent-callable query tools (reads)

BEGIN;

-- ── seo_crawl_runs ─────────────────────────────────────────────────────────
-- One row per crawl execution. Tracks scope (full vs delta vs targeted),
-- progress, and final stats. Crawls are durable enough that a worker
-- restart can be detected here (status='in_progress' rows with no
-- updates for >crawl_timeout = stuck; reaper should mark failed).

CREATE TABLE IF NOT EXISTS seo_crawl_runs (
  id              UUID PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  crawl_kind      TEXT NOT NULL CHECK (crawl_kind IN ('full', 'delta', 'targeted')),
  seed_urls       TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL CHECK (status IN
                    ('queued', 'in_progress', 'completed', 'failed', 'cancelled')),
  pages_crawled   INTEGER NOT NULL DEFAULT 0,
  pages_failed    INTEGER NOT NULL DEFAULT 0,
  pages_skipped   INTEGER NOT NULL DEFAULT 0,  -- robots-disallowed, depth-capped, etc.
  max_pages       INTEGER NOT NULL,
  max_depth       INTEGER NOT NULL,
  user_agent      TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  error           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_seo_crawl_runs_tenant_started
  ON seo_crawl_runs (tenant_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_seo_crawl_runs_status
  ON seo_crawl_runs (status)
  WHERE status IN ('queued', 'in_progress');

-- ── seo_page_inventory ─────────────────────────────────────────────────────
-- Current state of every crawled page per (tenant, url). UPSERTed each
-- crawl; rows persist across crawls so we can diff against prior state.
-- content_hash enables cheap change detection.
--
-- Column choice notes:
--   - schema_types is TEXT[] (e.g. ['Restaurant','Product']) not JSONB —
--     the JSON-LD parsed payloads themselves get stored under metadata
--     on the crawl_runs row if needed, keeping page_inventory queryable.
--   - target_cluster_id is nullable — set by a downstream classifier
--     (not the crawler itself). The crawler only fills in raw signals.
--   - blob_gcs_uri is nullable — if blob storage is enabled, the raw HTML
--     is stashed there for snapshot/rollback purposes (Rollout 2 in main
--     ROADMAP). Crawler writes the URI; doesn't require GCS to be wired
--     for the table to be useful.

CREATE TABLE IF NOT EXISTS seo_page_inventory (
  tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),
  url                 TEXT NOT NULL,
  last_crawl_run_id   UUID REFERENCES seo_crawl_runs(id),
  last_crawled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  first_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  http_status         INTEGER,
  final_url           TEXT,                 -- after redirects
  content_type        TEXT,
  content_hash        TEXT,                 -- sha256 of normalized body text
  word_count          INTEGER,

  -- ── SEO signals (mirror analyze_page where overlapping) ────
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

  -- ── Link counts (graph itself lives in seo_internal_links) ────
  internal_links_out  INTEGER NOT NULL DEFAULT 0,
  external_links_out  INTEGER NOT NULL DEFAULT 0,

  -- ── Image stats ────
  image_count         INTEGER NOT NULL DEFAULT 0,
  images_with_alt     INTEGER NOT NULL DEFAULT 0,
  images_missing_alt  INTEGER NOT NULL DEFAULT 0,

  -- ── Optional augmentations (filled by downstream skills, not the crawler) ────
  target_cluster_id   UUID,
  blob_gcs_uri        TEXT,

  -- ── Bookkeeping ────
  fetch_error         TEXT,                 -- set if the fetch itself failed
  PRIMARY KEY (tenant_id, url)
);

CREATE INDEX IF NOT EXISTS idx_seo_page_inventory_tenant_crawled
  ON seo_page_inventory (tenant_id, last_crawled_at DESC);

CREATE INDEX IF NOT EXISTS idx_seo_page_inventory_tenant_status
  ON seo_page_inventory (tenant_id, http_status);

-- Hash-based change detection: index supports "find all pages whose hash
-- changed since timestamp X" without table scan.
CREATE INDEX IF NOT EXISTS idx_seo_page_inventory_hash
  ON seo_page_inventory (tenant_id, content_hash);

-- ── seo_internal_links ─────────────────────────────────────────────────────
-- Per-edge link graph. One row per (tenant, source_url, target_url,
-- anchor_text_normalized) so the same logical edge with the same anchor
-- is deduped, but different anchors are kept (operators care about anchor
-- variation).
--
-- Replaced wholesale per source_url on each crawl — see store.ts
-- replaceLinksForSource(). This keeps the graph clean rather than
-- accumulating stale edges.
--
-- "Internal" is determined by the crawler at write time (registrable
-- domain match), not stored as a flag. External links are tracked only
-- as a count on page_inventory.

CREATE TABLE IF NOT EXISTS seo_internal_links (
  tenant_id           TEXT NOT NULL REFERENCES tenants(tenant_id),
  source_url          TEXT NOT NULL,
  target_url          TEXT NOT NULL,
  anchor_text         TEXT NOT NULL DEFAULT '',
  rel                 TEXT,                       -- e.g. 'nofollow', 'sponsored'
  is_nav              BOOLEAN NOT NULL DEFAULT false,  -- heuristic: link sits inside <nav> / <header> / <footer>
  position_index      INTEGER NOT NULL DEFAULT 0, -- order of link on page (0-indexed)
  last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, source_url, target_url, anchor_text)
);

CREATE INDEX IF NOT EXISTS idx_seo_internal_links_target
  ON seo_internal_links (tenant_id, target_url);

CREATE INDEX IF NOT EXISTS idx_seo_internal_links_source
  ON seo_internal_links (tenant_id, source_url);

-- Partial index for non-nav links — most "real" internal-link analysis
-- (orphan detection, anchor distribution) wants to exclude global nav.
CREATE INDEX IF NOT EXISTS idx_seo_internal_links_target_content
  ON seo_internal_links (tenant_id, target_url)
  WHERE is_nav = false;

COMMIT;
