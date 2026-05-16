// src/core/crawler/types.ts
//
// Shared types for the SEO-1 crawler module. Kept in one file so the
// fetcher / parser / crawler / store layers reference a single source of
// truth without circular imports.

// ── Crawl configuration ───────────────────────────────────────────────────

export type CrawlKind = 'full' | 'delta' | 'targeted'

export type CrawlStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface CrawlConfig {
  tenantId:     string
  /** Seeds for BFS. Typically [`https://<target_domain>/`, sitemap URLs]. */
  seedUrls:     string[]
  /** Logical name for this crawl. Drives whether deltas are computed against prior crawl. */
  crawlKind:    CrawlKind
  /** Hard cap on pages visited (HTTP-fetched). Skipped pages don't count. */
  maxPages:     number
  /** BFS depth cap. Seeds are depth 0. */
  maxDepth:     number
  /** Min ms between requests to the same host. Default 500ms. */
  throttleMs:   number
  /** Per-request fetch timeout in ms. Default 15_000. */
  fetchTimeoutMs: number
  /** UA string. Default 'CGSAuditBot/1.0 (+https://cgs.example/bots)'. Override per tenant. */
  userAgent:    string
  /** Whether to obey robots.txt. Default true. Disable only for tenant-owned sites with explicit consent. */
  respectRobots: boolean
  /** Host allowlist. Defaults to the registrable domain of the first seed; cross-domain links won't be crawled. */
  allowedHosts: string[]
  /** Optional metadata passed through to seo_crawl_runs.metadata. */
  metadata?:    Record<string, unknown>
}

export const DEFAULT_CRAWL_CONFIG = {
  crawlKind:      'full' as CrawlKind,
  maxPages:       500,
  maxDepth:       8,
  throttleMs:     500,
  fetchTimeoutMs: 15_000,
  userAgent:      'CGSAuditBot/1.0 (+https://cgs.example/bots)',
  respectRobots:  true,
} as const

// ── Fetch result ──────────────────────────────────────────────────────────

export interface FetchResult {
  /** Original URL requested (pre-redirect). */
  url:           string
  /** Final URL after redirects. */
  finalUrl:      string
  status:        number
  contentType:   string | null
  body:          string | null    // null when fetch failed or non-HTML
  elapsedMs:     number
  error:         string | null
  /** Set when robots disallowed the URL. */
  robotsBlocked: boolean
}

// ── Parsed page ───────────────────────────────────────────────────────────
//
// Output of parser.parsePage(). The crawler turns this into both an
// inventory row and a list of internal-link rows.

export interface ParsedPage {
  // ── Identity
  url:               string
  finalUrl:          string
  httpStatus:        number
  contentType:       string | null
  contentHash:       string | null  // sha256 of normalized text body

  // ── Head tags
  title:             string | null
  titleLength:       number
  metaDescription:   string | null
  metaDescLength:    number
  metaRobots:        string | null
  canonicalUrl:      string | null
  language:          string | null
  ogImage:           string | null

  // ── Headings
  h1Count:           number
  h1First:           string | null

  // ── Structured data
  schemaTypes:       string[]      // @type values across all JSON-LD blocks

  // ── Body
  wordCount:         number

  // ── Images
  imageCount:        number
  imagesWithAlt:     number
  imagesMissingAlt:  number  // includes both alt="" and missing alt entirely

  // ── Links (for the graph table)
  links:             ExtractedLink[]
  internalLinkCount: number
  externalLinkCount: number
}

export interface ExtractedLink {
  /** Absolute, normalized target URL. */
  target:        string
  /** Trimmed inner text of the <a>, capped at 300 chars. */
  anchorText:    string
  rel:           string | null
  /** True if the link sits inside <nav>, <header>, or <footer>. Heuristic. */
  isNav:         boolean
  /** Order on the page (0-indexed in document order). */
  positionIndex: number
  /** True if the target hostname matches the page hostname (registrable domain). */
  isInternal:    boolean
}

// ── Crawl result ──────────────────────────────────────────────────────────

export interface CrawlSummary {
  runId:         string
  tenantId:      string
  status:        CrawlStatus
  pagesCrawled:  number
  pagesFailed:   number
  pagesSkipped:  number
  startedAt:     Date
  completedAt:   Date | null
  durationMs:    number
  error:         string | null
  /** First few sample pages — useful for CLI summary output. */
  samples:       Array<{ url: string; status: number; title: string | null }>
}
