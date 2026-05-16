// src/core/crawler/store.ts
//
// DB layer for the three crawler tables. Writes are called by the
// crawler; reads are called by the agent-callable tools (and the CLI).
//
// All functions use a singleton pool (matching the pattern in
// src/skills/seo/tools.ts) so callers don't have to thread pg.Pool
// through every layer.

import { Pool } from 'pg'
import { config } from '../../config'
import { logger } from '../../logger'
import type {
  CrawlKind,
  CrawlStatus,
  ExtractedLink,
  ParsedPage,
} from './types'

let _pool: Pool | null = null

export function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL })
  return _pool
}

// ── Crawl-run lifecycle ───────────────────────────────────────────────────

export async function startCrawlRun(args: {
  runId:     string
  tenantId:  string
  crawlKind: CrawlKind
  seedUrls:  string[]
  maxPages:  number
  maxDepth:  number
  userAgent: string
  metadata:  Record<string, unknown>
}): Promise<void> {
  await pool().query(
    `INSERT INTO seo_crawl_runs
       (id, tenant_id, crawl_kind, seed_urls, status,
        max_pages, max_depth, user_agent, metadata)
     VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7, $8::jsonb)`,
    [
      args.runId, args.tenantId, args.crawlKind, args.seedUrls,
      args.maxPages, args.maxDepth, args.userAgent,
      JSON.stringify(args.metadata),
    ],
  )
}

export async function updateCrawlRunProgress(args: {
  runId:        string
  pagesCrawled: number
  pagesFailed:  number
  pagesSkipped: number
}): Promise<void> {
  await pool().query(
    `UPDATE seo_crawl_runs
        SET pages_crawled = $2,
            pages_failed  = $3,
            pages_skipped = $4
      WHERE id = $1`,
    [args.runId, args.pagesCrawled, args.pagesFailed, args.pagesSkipped],
  )
}

export async function finishCrawlRun(args: {
  runId:        string
  status:       CrawlStatus
  pagesCrawled: number
  pagesFailed:  number
  pagesSkipped: number
  completedAt:  Date
  error:        string | null
}): Promise<void> {
  await pool().query(
    `UPDATE seo_crawl_runs
        SET status        = $2,
            pages_crawled = $3,
            pages_failed  = $4,
            pages_skipped = $5,
            completed_at  = $6,
            error         = $7
      WHERE id = $1`,
    [
      args.runId, args.status, args.pagesCrawled, args.pagesFailed,
      args.pagesSkipped, args.completedAt, args.error,
    ],
  )
}

// ── Page-inventory writes ─────────────────────────────────────────────────

export async function upsertPageInventory(args: {
  tenantId: string
  runId:    string
  parsed:   ParsedPage
}): Promise<void> {
  const p = args.parsed
  // INSERT … ON CONFLICT UPDATE: first_seen_at is set only on insert;
  // last_crawled_at / last_crawl_run_id are refreshed on each crawl.
  await pool().query(
    `INSERT INTO seo_page_inventory (
        tenant_id, url, last_crawl_run_id, last_crawled_at,
        http_status, final_url, content_type, content_hash, word_count,
        title, title_length, meta_description, meta_desc_length, meta_robots,
        canonical_url, h1_count, h1_first, schema_types, og_image, language,
        internal_links_out, external_links_out,
        image_count, images_with_alt, images_missing_alt,
        fetch_error
     ) VALUES (
        $1, $2, $3, NOW(),
        $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13,
        $14, $15, $16, $17::text[], $18, $19,
        $20, $21,
        $22, $23, $24,
        NULL
     )
     ON CONFLICT (tenant_id, url) DO UPDATE SET
        last_crawl_run_id  = EXCLUDED.last_crawl_run_id,
        last_crawled_at    = EXCLUDED.last_crawled_at,
        http_status        = EXCLUDED.http_status,
        final_url          = EXCLUDED.final_url,
        content_type       = EXCLUDED.content_type,
        content_hash       = EXCLUDED.content_hash,
        word_count         = EXCLUDED.word_count,
        title              = EXCLUDED.title,
        title_length       = EXCLUDED.title_length,
        meta_description   = EXCLUDED.meta_description,
        meta_desc_length   = EXCLUDED.meta_desc_length,
        meta_robots        = EXCLUDED.meta_robots,
        canonical_url      = EXCLUDED.canonical_url,
        h1_count           = EXCLUDED.h1_count,
        h1_first           = EXCLUDED.h1_first,
        schema_types       = EXCLUDED.schema_types,
        og_image           = EXCLUDED.og_image,
        language           = EXCLUDED.language,
        internal_links_out = EXCLUDED.internal_links_out,
        external_links_out = EXCLUDED.external_links_out,
        image_count        = EXCLUDED.image_count,
        images_with_alt    = EXCLUDED.images_with_alt,
        images_missing_alt = EXCLUDED.images_missing_alt,
        fetch_error        = NULL`,
    [
      args.tenantId, p.url, args.runId,
      p.httpStatus, p.finalUrl, p.contentType, p.contentHash, p.wordCount,
      p.title, p.titleLength, p.metaDescription, p.metaDescLength, p.metaRobots,
      p.canonicalUrl, p.h1Count, p.h1First, p.schemaTypes, p.ogImage, p.language,
      p.internalLinkCount, p.externalLinkCount,
      p.imageCount, p.imagesWithAlt, p.imagesMissingAlt,
    ],
  )
}

export async function recordFetchFailure(args: {
  tenantId: string
  runId:    string
  url:      string
  error:    string
}): Promise<void> {
  // Even on fetch failure we want a row so the auditor knows "we tried,
  // it failed." Set fetch_error and clear successful fields.
  await pool().query(
    `INSERT INTO seo_page_inventory (
        tenant_id, url, last_crawl_run_id, last_crawled_at,
        http_status, fetch_error
     ) VALUES ($1, $2, $3, NOW(), 0, $4)
     ON CONFLICT (tenant_id, url) DO UPDATE SET
        last_crawl_run_id = EXCLUDED.last_crawl_run_id,
        last_crawled_at   = EXCLUDED.last_crawled_at,
        http_status       = EXCLUDED.http_status,
        fetch_error       = EXCLUDED.fetch_error`,
    [args.tenantId, args.url, args.runId, args.error],
  )
}

// ── Internal-link writes ──────────────────────────────────────────────────

/**
 * Replace all internal-link rows for `sourceUrl` with the supplied list,
 * atomically. This keeps the graph clean — if a page lost links since the
 * last crawl, the stale rows are gone, not orphaned.
 *
 * Done in one transaction. For typical pages (~50 links) this is fine; for
 * pathological pages with thousands of links the INSERT chunk could be
 * split, but defer that until we see it.
 */
export async function replaceLinksForSource(args: {
  tenantId:  string
  sourceUrl: string
  links:     ExtractedLink[]
}): Promise<void> {
  const internalLinks = args.links.filter((l) => l.isInternal)

  const client = await pool().connect()
  try {
    await client.query('BEGIN')

    await client.query(
      `DELETE FROM seo_internal_links
         WHERE tenant_id = $1 AND source_url = $2`,
      [args.tenantId, args.sourceUrl],
    )

    if (internalLinks.length > 0) {
      // Bulk insert via UNNEST for efficiency. Anchor text and target_url
      // form part of the PK so duplicates would error — but the parser
      // already deduped within-page (same target + same anchor on one
      // page collapses to one row). Cross-page duplicates aren't possible
      // since source_url differs.
      const targets    = internalLinks.map((l) => l.target)
      const anchors    = internalLinks.map((l) => l.anchorText)
      const rels       = internalLinks.map((l) => l.rel)
      const isNavs     = internalLinks.map((l) => l.isNav)
      const positions  = internalLinks.map((l) => l.positionIndex)

      await client.query(
        `INSERT INTO seo_internal_links
           (tenant_id, source_url, target_url, anchor_text, rel, is_nav, position_index, last_seen_at)
         SELECT $1, $2, t.target, t.anchor, t.rel, t.is_nav, t.pos, NOW()
           FROM UNNEST($3::text[], $4::text[], $5::text[], $6::boolean[], $7::int[])
             AS t(target, anchor, rel, is_nav, pos)
         ON CONFLICT (tenant_id, source_url, target_url, anchor_text)
         DO UPDATE SET
            rel            = EXCLUDED.rel,
            is_nav         = EXCLUDED.is_nav,
            position_index = EXCLUDED.position_index,
            last_seen_at   = NOW()`,
        [
          args.tenantId, args.sourceUrl,
          targets, anchors, rels, isNavs, positions,
        ],
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.warn('crawler_replace_links_failed', {
      tenantId: args.tenantId,
      sourceUrl: args.sourceUrl,
      err: String(err).slice(0, 300),
    })
    throw err
  } finally {
    client.release()
  }
}

// ── Reads (consumed by tools + CLI) ───────────────────────────────────────

export interface PageInventoryRow {
  url:              string
  finalUrl:         string | null
  httpStatus:       number | null
  title:            string | null
  metaDescription:  string | null
  canonicalUrl:     string | null
  metaRobots:       string | null
  h1Count:          number
  h1First:          string | null
  schemaTypes:      string[]
  wordCount:        number | null
  internalLinksOut: number
  externalLinksOut: number
  imageCount:       number
  imagesWithAlt:    number
  imagesMissingAlt: number
  lastCrawledAt:    Date
  fetchError:       string | null
}

export async function getLatestCrawlRun(tenantId: string): Promise<{
  runId:        string
  status:       CrawlStatus
  startedAt:    Date
  completedAt:  Date | null
  pagesCrawled: number
  pagesFailed:  number
  pagesSkipped: number
  error:        string | null
} | null> {
  const { rows } = await pool().query(
    `SELECT id, status, started_at, completed_at,
            pages_crawled, pages_failed, pages_skipped, error
       FROM seo_crawl_runs
      WHERE tenant_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [tenantId],
  )
  if (!rows.length) return null
  const r = rows[0]
  return {
    runId:        r.id,
    status:       r.status,
    startedAt:    r.started_at,
    completedAt:  r.completed_at,
    pagesCrawled: r.pages_crawled,
    pagesFailed:  r.pages_failed,
    pagesSkipped: r.pages_skipped,
    error:        r.error,
  }
}

export async function queryPageInventory(args: {
  tenantId:    string
  statusMin?:  number     // e.g. 400 → "anything 4xx or worse"
  statusMax?:  number
  missingH1?:  boolean
  missingMeta?: boolean
  hasSchemaType?: string  // case-sensitive, exact
  urlContains?: string
  limit?:      number
}): Promise<PageInventoryRow[]> {
  const conds: string[] = ['tenant_id = $1']
  const params: unknown[] = [args.tenantId]
  const push = (clause: string, value: unknown): void => {
    params.push(value)
    conds.push(clause.replace(/\$N/g, `$${params.length}`))
  }

  if (args.statusMin !== undefined) push('http_status >= $N', args.statusMin)
  if (args.statusMax !== undefined) push('http_status <= $N', args.statusMax)
  if (args.missingH1 === true)      conds.push('(h1_count IS NULL OR h1_count = 0)')
  if (args.missingMeta === true)    conds.push('(meta_description IS NULL OR meta_description = \'\')')
  if (args.hasSchemaType)           push('$N = ANY(schema_types)', args.hasSchemaType)
  if (args.urlContains)             push('url ILIKE $N', `%${args.urlContains}%`)

  const limit = Math.min(args.limit ?? 100, 500)

  const { rows } = await pool().query(
    `SELECT url, final_url, http_status, title, meta_description, canonical_url,
            meta_robots, h1_count, h1_first, schema_types, word_count,
            internal_links_out, external_links_out,
            image_count, images_with_alt, images_missing_alt,
            last_crawled_at, fetch_error
       FROM seo_page_inventory
      WHERE ${conds.join(' AND ')}
      ORDER BY last_crawled_at DESC
      LIMIT ${limit}`,
    params,
  )

  return rows.map((r): PageInventoryRow => ({
    url:              r.url,
    finalUrl:         r.final_url,
    httpStatus:       r.http_status,
    title:            r.title,
    metaDescription:  r.meta_description,
    canonicalUrl:     r.canonical_url,
    metaRobots:       r.meta_robots,
    h1Count:          r.h1_count ?? 0,
    h1First:          r.h1_first,
    schemaTypes:      r.schema_types ?? [],
    wordCount:        r.word_count,
    internalLinksOut: r.internal_links_out,
    externalLinksOut: r.external_links_out,
    imageCount:       r.image_count,
    imagesWithAlt:    r.images_with_alt,
    imagesMissingAlt: r.images_missing_alt,
    lastCrawledAt:    r.last_crawled_at,
    fetchError:       r.fetch_error,
  }))
}

export interface OrphanRow {
  url:           string
  title:         string | null
  lastCrawledAt: Date
}

/**
 * Pages in the inventory that have ZERO inbound *non-nav* internal links.
 * Excludes the homepage and any URL in the seed list (passed by caller)
 * since those are orphans-by-design.
 */
export async function findOrphans(args: {
  tenantId:     string
  excludeUrls?: string[]
  limit?:       number
}): Promise<OrphanRow[]> {
  const excludeUrls = args.excludeUrls ?? []
  const limit = Math.min(args.limit ?? 100, 500)

  const { rows } = await pool().query(
    `SELECT p.url, p.title, p.last_crawled_at
       FROM seo_page_inventory p
       LEFT JOIN seo_internal_links l
         ON l.tenant_id = p.tenant_id
        AND l.target_url = p.url
        AND l.is_nav = false
      WHERE p.tenant_id = $1
        AND p.http_status BETWEEN 200 AND 299
        AND ($2::text[] = '{}' OR NOT (p.url = ANY($2::text[])))
        AND l.target_url IS NULL
      ORDER BY p.last_crawled_at DESC
      LIMIT ${limit}`,
    [args.tenantId, excludeUrls],
  )

  return rows.map((r): OrphanRow => ({
    url:           r.url,
    title:         r.title,
    lastCrawledAt: r.last_crawled_at,
  }))
}

export interface BrokenLinkRow {
  sourceUrl:    string
  targetUrl:    string
  anchorText:   string
  targetStatus: number | null
  targetError:  string | null
}

/**
 * Internal links whose target has http_status >= 400 OR a fetch_error.
 * Joined to the source page so the caller knows which page to fix.
 */
export async function findBrokenInternalLinks(args: {
  tenantId: string
  limit?:   number
}): Promise<BrokenLinkRow[]> {
  const limit = Math.min(args.limit ?? 100, 500)
  const { rows } = await pool().query(
    `SELECT l.source_url, l.target_url, l.anchor_text,
            p.http_status, p.fetch_error
       FROM seo_internal_links l
       JOIN seo_page_inventory p
         ON p.tenant_id = l.tenant_id
        AND p.url = l.target_url
      WHERE l.tenant_id = $1
        AND (p.http_status >= 400 OR p.fetch_error IS NOT NULL)
      ORDER BY p.http_status DESC NULLS FIRST, l.source_url
      LIMIT ${limit}`,
    [args.tenantId],
  )

  return rows.map((r): BrokenLinkRow => ({
    sourceUrl:    r.source_url,
    targetUrl:    r.target_url,
    anchorText:   r.anchor_text,
    targetStatus: r.http_status,
    targetError:  r.fetch_error,
  }))
}

export interface InboundLinkRow {
  sourceUrl:    string
  anchorText:   string
  isNav:        boolean
  positionIndex: number
}

export async function getInboundLinks(args: {
  tenantId:  string
  targetUrl: string
  limit?:    number
}): Promise<InboundLinkRow[]> {
  const limit = Math.min(args.limit ?? 200, 500)
  const { rows } = await pool().query(
    `SELECT source_url, anchor_text, is_nav, position_index
       FROM seo_internal_links
      WHERE tenant_id = $1 AND target_url = $2
      ORDER BY is_nav ASC, source_url
      LIMIT ${limit}`,
    [args.tenantId, args.targetUrl],
  )
  return rows.map((r): InboundLinkRow => ({
    sourceUrl:    r.source_url,
    anchorText:   r.anchor_text,
    isNav:        r.is_nav,
    positionIndex: r.position_index,
  }))
}

export async function getCrawlSummaryStats(tenantId: string): Promise<{
  totalPages:     number
  pagesByStatus:  Record<string, number>
  pagesMissingH1: number
  pagesMissingMeta: number
  pagesNoIndex:   number
  orphanedPages:  number
  totalEdges:     number
}> {
  const [{ rows: countRows }, { rows: statusRows }, { rows: edgeRows }] = await Promise.all([
    pool().query(
      `SELECT
          COUNT(*)::int AS total,
          SUM(CASE WHEN h1_count IS NULL OR h1_count = 0 THEN 1 ELSE 0 END)::int AS missing_h1,
          SUM(CASE WHEN meta_description IS NULL OR meta_description = '' THEN 1 ELSE 0 END)::int AS missing_meta,
          SUM(CASE WHEN meta_robots ILIKE '%noindex%' THEN 1 ELSE 0 END)::int AS noindex_count
         FROM seo_page_inventory
        WHERE tenant_id = $1`,
      [tenantId],
    ),
    pool().query(
      `SELECT
          CASE
            WHEN http_status IS NULL THEN 'unknown'
            WHEN http_status BETWEEN 200 AND 299 THEN '2xx'
            WHEN http_status BETWEEN 300 AND 399 THEN '3xx'
            WHEN http_status BETWEEN 400 AND 499 THEN '4xx'
            WHEN http_status >= 500             THEN '5xx'
            ELSE 'other'
          END AS bucket,
          COUNT(*)::int AS n
         FROM seo_page_inventory
        WHERE tenant_id = $1
        GROUP BY bucket`,
      [tenantId],
    ),
    pool().query(
      `SELECT COUNT(*)::int AS edges
         FROM seo_internal_links
        WHERE tenant_id = $1`,
      [tenantId],
    ),
  ])

  const pagesByStatus: Record<string, number> = {}
  for (const r of statusRows) pagesByStatus[r.bucket] = r.n

  const orphans = await findOrphans({ tenantId, limit: 500 })

  return {
    totalPages:       countRows[0]?.total ?? 0,
    pagesByStatus,
    pagesMissingH1:   countRows[0]?.missing_h1 ?? 0,
    pagesMissingMeta: countRows[0]?.missing_meta ?? 0,
    pagesNoIndex:     countRows[0]?.noindex_count ?? 0,
    orphanedPages:    orphans.length,
    totalEdges:       edgeRows[0]?.edges ?? 0,
  }
}
