// src/skills/seo-technical-auditor/store.ts
//
// DB layer for the auditor. Loads crawl data, writes audit_runs + audit_findings,
// creates opportunities. Singleton pool to match the project's convention.

import { Pool } from 'pg'
import { v4 as uuid } from 'uuid'
import { config } from '../../config'
import type {
  AuditStatus,
  FindingState,
  InternalLink,
  PageInventory,
  ResolvedFinding,
  Severity,
} from './types'

let _pool: Pool | null = null
export function pool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: config.DATABASE_URL })
  return _pool
}

// ── Audit run lifecycle ───────────────────────────────────────────────────

export async function startAuditRun(args: {
  runId:        string
  tenantId:     string
  crawlRunId:   string | null
  metadata?:    Record<string, unknown>
}): Promise<void> {
  await pool().query(
    `INSERT INTO seo_audit_runs (id, tenant_id, crawl_run_id, status, metadata)
     VALUES ($1, $2, $3, 'in_progress', $4::jsonb)`,
    [args.runId, args.tenantId, args.crawlRunId, JSON.stringify(args.metadata ?? {})],
  )
}

export async function finishAuditRun(args: {
  runId:                string
  status:               AuditStatus
  findingsTotal:        number
  findingsNew:          number
  findingsPersistent:   number
  findingsResolved:     number
  opportunitiesCreated: number
  narrative:            string | null
  error:                string | null
}): Promise<void> {
  await pool().query(
    `UPDATE seo_audit_runs
        SET status                = $2,
            completed_at          = NOW(),
            findings_total        = $3,
            findings_new          = $4,
            findings_persistent   = $5,
            findings_resolved     = $6,
            opportunities_created = $7,
            narrative             = $8,
            error                 = $9
      WHERE id = $1`,
    [
      args.runId, args.status, args.findingsTotal, args.findingsNew,
      args.findingsPersistent, args.findingsResolved, args.opportunitiesCreated,
      args.narrative, args.error,
    ],
  )
}

// ── Load crawl data for the audit ─────────────────────────────────────────

export async function getLatestCrawlRunId(tenantId: string): Promise<string | null> {
  const { rows } = await pool().query(
    `SELECT id FROM seo_crawl_runs
      WHERE tenant_id = $1 AND status = 'completed'
      ORDER BY started_at DESC LIMIT 1`,
    [tenantId],
  )
  return rows[0]?.id ?? null
}

export async function loadPageInventory(tenantId: string): Promise<PageInventory[]> {
  const { rows } = await pool().query(
    `SELECT url, final_url, http_status, title, meta_description,
            canonical_url, meta_robots, h1_count, h1_first, schema_types,
            og_image, language, word_count,
            internal_links_out, external_links_out,
            image_count, images_with_alt, images_missing_alt,
            last_crawled_at, fetch_error
       FROM seo_page_inventory
      WHERE tenant_id = $1`,
    [tenantId],
  )
  return rows.map((r): PageInventory => ({
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
    ogImage:          r.og_image,
    language:         r.language,
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

export async function loadInternalLinks(tenantId: string): Promise<InternalLink[]> {
  const { rows } = await pool().query(
    `SELECT source_url, target_url, anchor_text, rel, is_nav, position_index
       FROM seo_internal_links
      WHERE tenant_id = $1`,
    [tenantId],
  )
  return rows.map((r): InternalLink => ({
    sourceUrl:     r.source_url,
    targetUrl:     r.target_url,
    anchorText:    r.anchor_text,
    rel:           r.rel,
    isNav:         r.is_nav,
    positionIndex: r.position_index,
  }))
}

// ── Findings: load prior + write current ──────────────────────────────────

/** Load the prior set of findings keyed by finding_key, for delta computation. */
export async function loadPriorFindings(tenantId: string): Promise<Map<string, ResolvedFinding>> {
  const { rows } = await pool().query(
    `SELECT id, check_name, finding_key, target_url, related_url,
            severity, state, first_seen_at, last_seen_at, weeks_open, detail
       FROM seo_audit_findings
      WHERE tenant_id = $1
        AND state IN ('new','persistent','ignored')`,
    [tenantId],
  )
  const map = new Map<string, ResolvedFinding>()
  for (const r of rows) {
    map.set(r.finding_key, {
      id:           r.id,
      checkName:    r.check_name,
      findingKey:   r.finding_key,
      targetUrl:    r.target_url,
      relatedUrl:   r.related_url,
      severity:     r.severity,
      state:        r.state,
      firstSeenAt:  r.first_seen_at,
      lastSeenAt:   r.last_seen_at,
      weeksOpen:    r.weeks_open,
      detail:       r.detail ?? {},
    })
  }
  return map
}

/**
 * UPSERT a finding. If finding_key already exists for the tenant, update
 * state/last_seen_at/weeks_open/detail. If new, insert.
 *
 * Returns the row id (existing or newly created).
 */
export async function upsertFinding(args: {
  tenantId:     string
  auditRunId:   string
  finding:      ResolvedFinding
}): Promise<string> {
  const f = args.finding
  const id = f.id || uuid()
  const { rows } = await pool().query(
    `INSERT INTO seo_audit_findings (
        id, tenant_id, audit_run_id, check_name, finding_key,
        target_url, related_url, severity, state,
        first_seen_at, last_seen_at, weeks_open, detail
     ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13::jsonb
     )
     ON CONFLICT (tenant_id, finding_key) DO UPDATE SET
        audit_run_id  = EXCLUDED.audit_run_id,
        target_url    = EXCLUDED.target_url,
        related_url   = EXCLUDED.related_url,
        severity      = EXCLUDED.severity,
        state         = EXCLUDED.state,
        last_seen_at  = EXCLUDED.last_seen_at,
        weeks_open    = EXCLUDED.weeks_open,
        detail        = EXCLUDED.detail
     RETURNING id`,
    [
      id, args.tenantId, args.auditRunId, f.checkName, f.findingKey,
      f.targetUrl, f.relatedUrl, f.severity, f.state,
      f.firstSeenAt, f.lastSeenAt, f.weeksOpen, JSON.stringify(f.detail),
    ],
  )
  return rows[0].id
}

/** Mark a finding 'resolved' — used when a previously-flagged issue isn't found in the current audit. */
export async function markResolved(args: {
  findingId: string
  auditRunId: string
}): Promise<void> {
  await pool().query(
    `UPDATE seo_audit_findings
        SET state = 'resolved',
            audit_run_id = $2,
            last_seen_at = NOW()
      WHERE id = $1`,
    [args.findingId, args.auditRunId],
  )
}

// ── Opportunities ─────────────────────────────────────────────────────────

export async function createOpportunity(args: {
  tenantId:        string
  auditRunId:      string
  type:            string
  target:          string | null
  description:     string
  rationale:       string
  priority:        Severity        // will be capped to P2 (existing CHECK constraint)
  estimatedImpact: string | null
  sourceFindingId: string | null
}): Promise<string> {
  const id = uuid()
  // seo_opportunities.priority CHECK only allows P0/P1/P2.
  const priority = args.priority === 'P3' ? 'P2' : args.priority
  await pool().query(
    `INSERT INTO seo_opportunities (
        id, tenant_id, run_id, type, target, description, rationale,
        priority, status, estimated_impact, source_finding_id
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, 'new', $9, $10
     )`,
    [
      id, args.tenantId, args.auditRunId, args.type, args.target,
      args.description, args.rationale, priority, args.estimatedImpact,
      args.sourceFindingId,
    ],
  )
  if (args.sourceFindingId) {
    // Back-link the finding to the opportunity it produced
    await pool().query(
      `UPDATE seo_audit_findings SET opportunity_id = $1 WHERE id = $2`,
      [id, args.sourceFindingId],
    )
  }
  return id
}

// ── Excludes (URLs that shouldn't trip orphan / sitemap-missing checks) ───

const STATIC_EXCLUDES = new Set([
  '/sitemap.xml', '/sitemap_index.xml', '/sitemap.xml.gz',
  '/robots.txt', '/feed', '/rss.xml', '/atom.xml',
  '/.well-known/', '/favicon.ico',
])

/** Build the per-tenant "URLs to skip from orphan / sitemap-missing findings" set. */
export function buildExclusionSet(pages: PageInventory[]): Set<string> {
  const out = new Set<string>()
  for (const p of pages) {
    try {
      const u = new URL(p.url)
      const pathLower = u.pathname.toLowerCase()
      if (STATIC_EXCLUDES.has(pathLower)) {
        out.add(p.url)
        if (p.finalUrl && p.finalUrl !== p.url) out.add(p.finalUrl)
        continue
      }
      // Also exclude /.well-known/* (could be admin endpoints)
      for (const ex of STATIC_EXCLUDES) {
        if (ex.endsWith('/') && pathLower.startsWith(ex)) {
          out.add(p.url)
          break
        }
      }
    } catch { /* invalid URL, skip */ }
  }
  return out
}
