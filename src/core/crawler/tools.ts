// src/core/crawler/tools.ts
//
// Agent-callable read tools for the crawled inventory. Anthropic-format
// tool definitions plus a dispatch function.
//
// Pattern matches src/skills/seo/tools.ts: one TOOLS array + one
// executeXxx switch, plus an isXxxToolName guard for the subagent.
//
// All read-only — no propose_action gating needed. Adding a write tool
// for triggering a crawl from the agent is deliberately out of scope:
// crawls run from cron, not from inside specialist runs. If we ever want
// agent-triggered crawls, that needs queue work to avoid blocking the
// specialist loop on a 5-minute crawl.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import {
  queryPageInventory,
  findOrphans,
  findBrokenInternalLinks,
  getInboundLinks,
  getLatestCrawlRun,
  getCrawlSummaryStats,
} from './store'

export const CRAWLER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'crawl_summary',
    description:
      'Summary stats of the latest site crawl for this tenant: total pages, ' +
      'status code distribution, count of pages missing H1, count missing meta ' +
      'description, count with noindex, count orphaned (no non-nav inbound links), ' +
      'total internal-link edges. Read this first to understand the shape of the ' +
      'site before drilling into specific issues. No input.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'query_pages',
    description:
      'Query the page inventory with filters. Returns up to `limit` pages (max 100). ' +
      'Use this to find pages matching a specific issue — e.g. all 4xx pages, all pages ' +
      'missing meta description, all pages with FAQPage schema, all pages whose URL ' +
      'contains a substring. Empty filters return the most recently crawled pages.',
    input_schema: {
      type: 'object' as const,
      properties: {
        statusMin:      { type: 'number', description: 'Minimum HTTP status. Use 400 to find errors.' },
        statusMax:      { type: 'number', description: 'Maximum HTTP status.' },
        missingH1:      { type: 'boolean', description: 'Only pages with no H1.' },
        missingMeta:    { type: 'boolean', description: 'Only pages with no meta description.' },
        hasSchemaType:  { type: 'string',  description: 'Filter to pages whose JSON-LD includes this @type, e.g. "FAQPage", "Product".' },
        urlContains:    { type: 'string',  description: 'Case-insensitive substring filter on URL.' },
        limit:          { type: 'number', description: 'Max rows (default 50, ceiling 100).' },
      },
    },
  },
  {
    name: 'find_orphans',
    description:
      'Find pages that have zero inbound non-nav internal links. ' +
      'Excludes the homepage by default. These are pages the agent might want to ' +
      'link to from relevant cluster pages — orphaned pages rarely rank. Returns ' +
      'up to `limit` URLs with titles.',
    input_schema: {
      type: 'object' as const,
      properties: {
        excludeUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'URLs to exclude from orphan detection (e.g. homepage, legal pages).',
        },
        limit: { type: 'number', description: 'Max rows (default 50, ceiling 100).' },
      },
    },
  },
  {
    name: 'find_broken_internal_links',
    description:
      'Internal links whose target page returned a 4xx/5xx or failed to fetch. ' +
      'Returns the source page, the broken target, and the anchor text. Useful for ' +
      'identifying pages that need link cleanup. Up to `limit` rows.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max rows (default 50, ceiling 100).' },
      },
    },
  },
  {
    name: 'get_inbound_links',
    description:
      'List the internal pages that link TO a specified target URL. Useful for ' +
      'understanding why a page ranks where it does, or for planning a URL change ' +
      '(you need to know what to update). Returns source URL + anchor text + nav flag.',
    input_schema: {
      type: 'object' as const,
      properties: {
        targetUrl: { type: 'string', description: 'The page whose inbound links to list.' },
        limit:     { type: 'number', description: 'Max rows (default 100, ceiling 200).' },
      },
      required: ['targetUrl'],
    },
  },
  {
    name: 'latest_crawl_status',
    description:
      'Get the most recent crawl run for this tenant — status, when it ran, page counts, ' +
      'any error. Use to confirm crawl data is fresh before drawing conclusions.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
]

export function isCrawlerToolName(name: string): boolean {
  return CRAWLER_TOOLS.some((t) => t.name === name)
}

export async function executeCrawlerTool(
  name: string,
  input: Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  switch (name) {
    case 'crawl_summary':                return await doCrawlSummary(tenant)
    case 'query_pages':                  return await doQueryPages(tenant, input)
    case 'find_orphans':                 return await doFindOrphans(tenant, input)
    case 'find_broken_internal_links':   return await doFindBrokenLinks(tenant, input)
    case 'get_inbound_links':            return await doGetInbound(tenant, input)
    case 'latest_crawl_status':          return await doLatestCrawlStatus(tenant)
    default:                             return `unknown crawler tool: ${name}`
  }
}

// ── Dispatchers ───────────────────────────────────────────────────────────

async function doCrawlSummary(tenant: TenantConfig): Promise<string> {
  const latest = await getLatestCrawlRun(tenant.tenantId)
  if (!latest) {
    return 'No crawl data yet for this tenant. Run `npm run crawl ' + tenant.tenantId +
      '` (or wait for the next scheduled crawl) before using inventory tools.'
  }

  const stats = await getCrawlSummaryStats(tenant.tenantId)
  const ageMin = Math.round((Date.now() - latest.startedAt.getTime()) / 60_000)

  const lines = [
    `# Crawl summary for ${tenant.tenantId}`,
    '',
    `Latest crawl: ${latest.status} (${ageMin}m ago, runId=${latest.runId.slice(0, 8)})`,
    `Pages crawled: ${latest.pagesCrawled} | failed: ${latest.pagesFailed} | skipped: ${latest.pagesSkipped}`,
    latest.error ? `Error: ${latest.error}` : '',
    '',
    `## Inventory (across all crawls)`,
    `Total pages: ${stats.totalPages}`,
    `Status breakdown: ${formatStatusBreakdown(stats.pagesByStatus)}`,
    `Missing H1: ${stats.pagesMissingH1}`,
    `Missing meta description: ${stats.pagesMissingMeta}`,
    `Noindex: ${stats.pagesNoIndex}`,
    `Orphaned (no non-nav inbound): ${stats.orphanedPages}`,
    `Total internal-link edges: ${stats.totalEdges}`,
  ].filter(Boolean)

  return lines.join('\n')
}

async function doQueryPages(tenant: TenantConfig, input: Record<string, unknown>): Promise<string> {
  const rows = await queryPageInventory({
    tenantId:     tenant.tenantId,
    statusMin:    numOrUndef(input.statusMin),
    statusMax:    numOrUndef(input.statusMax),
    missingH1:    boolOrUndef(input.missingH1),
    missingMeta:  boolOrUndef(input.missingMeta),
    hasSchemaType: strOrUndef(input.hasSchemaType),
    urlContains:  strOrUndef(input.urlContains),
    limit:        numOrUndef(input.limit) ?? 50,
  })

  if (!rows.length) return 'No pages match those filters.'

  const lines = [`# ${rows.length} pages`]
  for (const r of rows) {
    const status = r.httpStatus ?? '—'
    const title = r.title ? r.title.slice(0, 60) : '(no title)'
    const flags: string[] = []
    if (r.h1Count === 0) flags.push('no-h1')
    if (!r.metaDescription) flags.push('no-meta')
    if (r.metaRobots?.toLowerCase().includes('noindex')) flags.push('noindex')
    if (r.canonicalUrl && r.canonicalUrl !== r.finalUrl) flags.push('canonical→other')
    if (r.fetchError) flags.push('fetch-failed')
    const flagsStr = flags.length ? ` [${flags.join(', ')}]` : ''
    lines.push(`- [${status}] ${r.url} — ${title}${flagsStr}`)
  }
  return lines.join('\n')
}

async function doFindOrphans(tenant: TenantConfig, input: Record<string, unknown>): Promise<string> {
  const excludeUrls = Array.isArray(input.excludeUrls)
    ? (input.excludeUrls as unknown[]).filter((v): v is string => typeof v === 'string')
    : []

  // Always exclude the seed-derived homepage unless explicitly included.
  // Homepage is always linked from the root, but it's typically the seed
  // and won't have inbound links indexed in the same way.

  const rows = await findOrphans({
    tenantId:     tenant.tenantId,
    excludeUrls,
    limit:        numOrUndef(input.limit) ?? 50,
  })

  if (!rows.length) return 'No orphaned pages found.'

  const lines = [`# ${rows.length} orphaned page${rows.length === 1 ? '' : 's'}`]
  for (const r of rows) {
    lines.push(`- ${r.url} — ${r.title ?? '(no title)'}`)
  }
  return lines.join('\n')
}

async function doFindBrokenLinks(tenant: TenantConfig, input: Record<string, unknown>): Promise<string> {
  const rows = await findBrokenInternalLinks({
    tenantId: tenant.tenantId,
    limit:    numOrUndef(input.limit) ?? 50,
  })
  if (!rows.length) return 'No broken internal links found.'

  const lines = [`# ${rows.length} broken internal link${rows.length === 1 ? '' : 's'}`]
  for (const r of rows) {
    const status = r.targetStatus ?? (r.targetError ? `err:${r.targetError.slice(0, 30)}` : '—')
    lines.push(`- [${status}] ${r.sourceUrl}  →  ${r.targetUrl}  ("${r.anchorText.slice(0, 60)}")`)
  }
  return lines.join('\n')
}

async function doGetInbound(tenant: TenantConfig, input: Record<string, unknown>): Promise<string> {
  const targetUrl = strOrUndef(input.targetUrl)
  if (!targetUrl) return 'targetUrl is required'

  const rows = await getInboundLinks({
    tenantId:  tenant.tenantId,
    targetUrl,
    limit:     numOrUndef(input.limit) ?? 100,
  })

  if (!rows.length) return `No inbound internal links found pointing to ${targetUrl}.`

  const nav = rows.filter((r) => r.isNav).length
  const content = rows.length - nav
  const lines = [
    `# ${rows.length} inbound link${rows.length === 1 ? '' : 's'} to ${targetUrl}`,
    `(${content} content, ${nav} nav)`,
    '',
  ]
  for (const r of rows) {
    const tag = r.isNav ? '[nav]' : '     '
    lines.push(`${tag} ${r.sourceUrl}  "${r.anchorText.slice(0, 80)}"`)
  }
  return lines.join('\n')
}

async function doLatestCrawlStatus(tenant: TenantConfig): Promise<string> {
  const latest = await getLatestCrawlRun(tenant.tenantId)
  if (!latest) return 'No crawl runs yet for this tenant.'

  const startedAgo = Math.round((Date.now() - latest.startedAt.getTime()) / 60_000)
  const completedStr = latest.completedAt
    ? `completed ${Math.round((Date.now() - latest.completedAt.getTime()) / 60_000)}m ago`
    : 'still running'

  return [
    `Run ID:   ${latest.runId}`,
    `Status:   ${latest.status} (${completedStr})`,
    `Started:  ${startedAgo}m ago (${latest.startedAt.toISOString()})`,
    `Crawled:  ${latest.pagesCrawled} pages`,
    `Failed:   ${latest.pagesFailed}`,
    `Skipped:  ${latest.pagesSkipped}`,
    latest.error ? `Error:    ${latest.error}` : '',
  ].filter(Boolean).join('\n')
}

// ── Type coercion helpers (defensive against LLM-supplied input) ──────────

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && !isNaN(Number(v))) return Number(v)
  return undefined
}

function strOrUndef(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v.trim()
  return undefined
}

function boolOrUndef(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return undefined
}

function formatStatusBreakdown(map: Record<string, number>): string {
  const keys = Object.keys(map).sort()
  if (!keys.length) return '(none)'
  return keys.map((k) => `${k}=${map[k]}`).join(', ')
}
