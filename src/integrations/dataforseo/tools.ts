// src/integrations/dataforseo/tools.ts

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import * as dfs from './client'
import { pool } from '../../memory/postgres'
import { cachedJson } from '../../core/cache/cached-fetch'

// Cost-efficiency (2026-07-24): DataForSEO calls are metered AND the same
// questions repeat across the day's runs (morning daily, afternoon daily,
// discovery cycles all look at the same domain/keywords). Read-through
// cache via cache_entries: keyword/domain data ages in weeks, SERPs in
// days — a same-day repeat call should never hit the vendor.
const DFS_TTL: Record<string, number> = {
  dataforseo_keyword_overview:     7 * 86_400,
  dataforseo_ranked_keywords:      3 * 86_400,
  dataforseo_keywords_for_site:    7 * 86_400,
  dataforseo_serp:                 2 * 86_400,
  dataforseo_backlinks_summary:    7 * 86_400,
  dataforseo_competitor_research: 14 * 86_400,
}

async function dfsCached(
  tenant: TenantConfig,
  name: string,
  input: Record<string, unknown>,
  fetcher: () => Promise<unknown>,
): Promise<string> {
  const key = `${name}:${JSON.stringify(input)}`.slice(0, 500)
  const r = await cachedJson({
    pool, source: 'dataforseo', tenantId: tenant.tenantId, key,
    ttlSeconds: DFS_TTL[name] ?? 86_400, fetcher,
  })
  return JSON.stringify(r.value)
}

export const DATAFORSEO_TOOLS: Anthropic.Tool[] = [
  {
    name: 'dataforseo_keyword_overview',
    description:
      "Look up search volume, keyword difficulty, CPC, and search intent for 1-50 keywords. " +
      "Use this when evaluating a keyword opportunity before recommending the tenant target it. " +
      "Cost: 1 row per keyword. Keep lists small (5-20) for exploratory work.",
    input_schema: {
      type: 'object' as const,
      properties: {
        keywords:     { type: 'array', items: { type: 'string' }, description: '1-50 keywords to look up' },
        locationCode: { type: 'integer', description: 'Location code (default 2036 = Australia). 2840 = USA, 2826 = UK, 2124 = Canada.' },
        languageCode: { type: 'string', description: 'Language code (default "en")' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'dataforseo_ranked_keywords',
    description:
      "Get every keyword the tenant's domain currently ranks for in Google, with position, search volume, and the ranking URL. " +
      "USE THIS for an overall picture of what's working organically. Often the highest-leverage move is improving keywords already on page 2 → page 1, which this surfaces. " +
      "Cost: scales with limit. Use limit=50 for an overview, raise only if needed.",
    input_schema: {
      type: 'object' as const,
      properties: {
        target:       { type: 'string', description: 'Domain to query, e.g. "tarino.au"' },
        locationCode: { type: 'integer', description: 'Default 2036 (Australia)' },
        languageCode: { type: 'string', description: 'Default "en"' },
        limit:        { type: 'integer', description: 'Default 50. Raise cautiously.' },
      },
      required: ['target'],
    },
  },
  {
    name: 'dataforseo_keywords_for_site',
    description:
      "Get keyword IDEAS for a domain — keywords that match the domain's topic and content but the domain may NOT yet rank for. " +
      "USE THIS for content gap analysis: what keywords does this domain align with that they haven't yet captured. Complement to ranked_keywords.",
    input_schema: {
      type: 'object' as const,
      properties: {
        target:       { type: 'string', description: 'Domain, e.g. "tarino.au"' },
        locationCode: { type: 'integer', description: 'Default 2036 (Australia)' },
        languageCode: { type: 'string', description: 'Default "en"' },
        limit:        { type: 'integer', description: 'Default 50' },
      },
      required: ['target'],
    },
  },
  {
    name: 'dataforseo_serp',
    description:
      "Get the live Google search results for a query — top 20 organic results with rank, URL, title, description. " +
      "USE THIS to understand the competitive landscape for a keyword before recommending it. Look at: who's ranking, what intent the page satisfies (informational/transactional/comparison), what page format dominates (guide vs product vs listicle).",
    input_schema: {
      type: 'object' as const,
      properties: {
        keyword:      { type: 'string', description: 'Search query' },
        locationCode: { type: 'integer', description: 'Default 2036 (Australia)' },
        languageCode: { type: 'string', description: 'Default "en"' },
        depth:        { type: 'integer', description: 'Number of results to retrieve (default 20, max 100)' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'dataforseo_backlinks_summary',
    description:
      "Get a high-level backlink summary for a domain: total backlinks, referring domains, rank, first seen date. " +
      "USE THIS as a snapshot of off-site authority. Run sparingly — for tenant context once, then re-check monthly. NOT for daily monitoring (too expensive).",
    input_schema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Domain, e.g. "tarino.au"' },
      },
      required: ['target'],
    },
  },
  {
    name: 'dataforseo_competitor_research',
    description:
      "Discover competitors for a domain — returns top 5-10 domains that rank for overlapping keywords, with intersection counts and traffic estimates. " +
      "USE THIS when the tenant.competitorDomains list is empty or you want to validate the configured competitors. " +
      "Returns one row per competitor with: domain, intersections (shared keywords), avg_position (where they rank), etv (estimated organic traffic). " +
      "Run once per tenant context, not per query — results are stable day-to-day.",
    input_schema: {
      type: 'object' as const,
      properties: {
        target:       { type: 'string', description: 'Target domain, e.g. "tarino.au" (no protocol or path)' },
        limit:        { type: 'number', description: 'Max competitors to return (default 10)' },
        locationCode: { type: 'number', description: 'DataForSEO location code (2036 = Australia, default)' },
        languageCode: { type: 'string', description: 'ISO language code (default "en")' },
      },
      required: ['target'],
    },
  },
]

const DATAFORSEO_TOOL_NAMES = new Set(DATAFORSEO_TOOLS.map(t => t.name))

export function isDataForSeoToolName(name: string): boolean {
  return DATAFORSEO_TOOL_NAMES.has(name)
}

export async function executeDataForSeoTool(
  name:    string,
  input:   Record<string, unknown>,
  tenant:  TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'dataforseo_keyword_overview': {
        const i = input as { keywords: string[]; locationCode?: number; languageCode?: string }
        if (!i.keywords?.length) return 'dataforseo_keyword_overview error: keywords (non-empty) required'
        return dfsCached(tenant, name, i as Record<string, unknown>, () => dfs.keywordOverview(tenant, i))
      }
      case 'dataforseo_ranked_keywords': {
        const i = input as { target: string; locationCode?: number; languageCode?: string; limit?: number }
        if (!i.target) return 'dataforseo_ranked_keywords error: target required'
        return dfsCached(tenant, name, i as Record<string, unknown>, () => dfs.rankedKeywords(tenant, i))
      }
      case 'dataforseo_keywords_for_site': {
        const i = input as { target: string; locationCode?: number; languageCode?: string; limit?: number }
        if (!i.target) return 'dataforseo_keywords_for_site error: target required'
        return dfsCached(tenant, name, i as Record<string, unknown>, () => dfs.keywordsForSite(tenant, i))
      }
      case 'dataforseo_serp': {
        const i = input as { keyword: string; locationCode?: number; languageCode?: string; depth?: number }
        if (!i.keyword) return 'dataforseo_serp error: keyword required'
        return dfsCached(tenant, name, i as Record<string, unknown>, () => dfs.serpOrganicLive(tenant, i))
      }
      case 'dataforseo_backlinks_summary': {
        const i = input as { target: string }
        if (!i.target) return 'dataforseo_backlinks_summary error: target required'
        return dfsCached(tenant, name, i as Record<string, unknown>, () => dfs.backlinksSummary(tenant, i))
      }
      case 'dataforseo_competitor_research': {
        const i = input as { target: string; limit?: number; locationCode?: number; languageCode?: string }
        if (!i.target) return 'dataforseo_competitor_research error: target required'
        return dfsCached(tenant, name, i as Record<string, unknown>, () => dfs.competitorsDomain(tenant, i))
      }
      default:
        return `Unknown DataForSEO tool: ${name}`
    }
  } catch (err) {
    return `DataForSEO tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
