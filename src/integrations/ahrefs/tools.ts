// src/integrations/ahrefs/tools.ts
//
// Read-only Ahrefs tools (auto-execute tier — no HITL), mapped to the six
// core CGS SEO activities:
//
//   Content rewriting    → ahrefs_organic_keywords (mode=exact on the URL:
//                          what the page ranks for + striking-distance
//                          positions 4–15 = rewrite targets),
//                          ahrefs_serp_overview (who we're up against)
//   Interpage linking    → ahrefs_top_pages (authority/traffic hubs = link
//                          sources), ahrefs_best_by_internal_links (which
//                          pages hog internal links vs which are starved)
//   Backlink hunting     → ahrefs_backlink_gap (domains linking to a
//                          competitor but not us, by DR — the flagship),
//                          ahrefs_backlinks, ahrefs_referring_domains,
//                          ahrefs_broken_backlinks (reclamation on our
//                          domain; broken-link building on competitors'),
//                          ahrefs_organic_competitors (who to gap against)
//   Copy optimisation    → ahrefs_organic_keywords (exact), 
//                          ahrefs_keyword_ideas, ahrefs_keyword_metrics
//   Metadata optimisation→ ahrefs_organic_keywords (title↔query alignment),
//                          ahrefs_serp_overview (competing titles on SERP)
//   Technical SEO        → ahrefs_broken_backlinks on our own domain
//                          (404 targets with link equity → redirect map)
//
// Every call is cached (TTLs below) and row-capped, because Ahrefs bills
// per row × field with a 50-unit floor. If Ahrefs rejects a `select`, its
// error lists ALL valid columns — that error flows back to you, so adjust
// and retry.

import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../../memory/postgres'
import { cachedJson, TTL } from '../../core/cache/cached-fetch'
import * as ahrefs from './client'
import type { TenantConfig } from '../../tenants/types'

const MAX_ROWS = 25
const GAP_OWN_SIDE_ROWS = 100   // our refdomain set for diffing — cached 14d, reused across every competitor gap

export const AHREFS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'ahrefs_domain_rating',
    description: 'Ahrefs Domain Rating (DR) for a domain. Use to qualify backlink prospects and calibrate competitor strength. Cached 7d.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Domain, e.g. acme.com' } },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_backlinks',
    description: 'Top backlinks for a domain/URL by source DR, one per referring domain (max 25). [Backlink hunting] Cached 14d.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Domain or URL' },
        limit:  { type: 'number', description: 'Max 25 (default 10)' },
        mode:   { type: 'string', enum: ['exact', 'prefix', 'domain', 'subdomains'], description: 'Default subdomains; use exact for a single URL' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_referring_domains',
    description: 'Top referring domains for a target by DR (max 25). [Backlink hunting] Cached 14d.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' }, limit: { type: 'number', description: 'Max 25 (default 10)' } },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_backlink_gap',
    description: 'Domains linking to a COMPETITOR but NOT to us, sorted by DR — directly actionable outreach prospects. [Backlink hunting — flagship] Our own refdomain set is cached 14d and reused across every competitor you gap against.',
    input_schema: {
      type: 'object',
      properties: {
        competitor: { type: 'string', description: 'Competitor domain to gap against' },
        our_domain: { type: 'string', description: 'Our domain (defaults to tenant target domain)' },
        limit:      { type: 'number', description: 'Prospect rows to return, max 25 (default 15)' },
      },
      required: ['competitor'],
    },
  },
  {
    name: 'ahrefs_broken_backlinks',
    description: 'Backlinks pointing at broken (non-functioning) pages, by source DR (max 25). On OUR domain: link equity leaking to 404s → redirect map [Technical SEO + reclamation]. On a COMPETITOR: broken-link-building pitches [Backlink hunting]. Cached 14d.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' }, limit: { type: 'number', description: 'Max 25 (default 10)' } },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_organic_competitors',
    description: 'Domains competing with the target in organic search, with keyword overlap counts. Use to pick gap-analysis targets. [Backlink hunting + content strategy] Cached 30d.',
    input_schema: {
      type: 'object',
      properties: {
        target:  { type: 'string' },
        country: { type: 'string', description: 'Two-letter code (default au)' },
        limit:   { type: 'number', description: 'Max 25 (default 10)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_organic_keywords',
    description: 'Organic keywords a target ranks for, by traffic (max 25). mode=exact with a page URL = what THAT PAGE ranks for, incl. striking-distance positions 4–15 — the primary input for content rewriting, copy optimisation, and title/meta alignment. mode=subdomains with a competitor domain = keyword-gap fodder. Cached 30d.',
    input_schema: {
      type: 'object',
      properties: {
        target:  { type: 'string', description: 'Domain (mode=subdomains) or full page URL (mode=exact)' },
        mode:    { type: 'string', enum: ['exact', 'prefix', 'domain', 'subdomains'], description: 'exact for a single page; default subdomains' },
        country: { type: 'string', description: 'Two-letter code (default au)' },
        limit:   { type: 'number', description: 'Max 25 (default 10)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_top_pages',
    description: 'Top pages of a domain by organic traffic, with their top keyword (max 25). Our domain: authority hubs = internal-link SOURCES [Interpage linking] and rewrite-priority ranking. Competitor: what content wins for them [content strategy]. Cached 7d.',
    input_schema: {
      type: 'object',
      properties: {
        target:  { type: 'string' },
        country: { type: 'string', description: 'Two-letter code (default au)' },
        limit:   { type: 'number', description: 'Max 25 (default 10)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_best_by_internal_links',
    description: 'Pages of a domain ranked by internal link count (max 25). High-count pages = established hubs; valuable pages NOT near the top = internally starved → linking opportunities. [Interpage linking] Cached 7d.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string' }, limit: { type: 'number', description: 'Max 25 (default 10)' } },
      required: ['target'],
    },
  },
  {
    name: 'ahrefs_keyword_ideas',
    description: 'Matching-term keyword ideas for a seed keyword with volume + difficulty (max 25). [Copy optimisation + content briefs] Cached 30d.',
    input_schema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Seed keyword' },
        country: { type: 'string', description: 'Two-letter code (default au)' },
        limit:   { type: 'number', description: 'Max 25 (default 10)' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'ahrefs_keyword_metrics',
    description: 'Volume, difficulty, CPC, traffic potential for up to 10 comma-separated keywords. [Copy optimisation + prioritisation] Cached 30d.',
    input_schema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Comma-separated, max 10' },
        country:  { type: 'string', description: 'Two-letter code (default au)' },
      },
      required: ['keywords'],
    },
  },
  {
    name: 'ahrefs_serp_overview',
    description: 'Top SERP results for a keyword with title, URL rating, backlinks, traffic. Shows exactly who ranks and how strong they are — calibrates rewrite effort and informs title/meta against what already wins. [Content rewriting + Metadata optimisation] Cached 3d.',
    input_schema: {
      type: 'object',
      properties: {
        keyword:       { type: 'string' },
        country:       { type: 'string', description: 'Two-letter code (default au)' },
        top_positions: { type: 'number', description: 'How many positions, max 10 (default 10)' },
      },
      required: ['keyword'],
    },
  },
]

export function isAhrefsToolName(name: string): boolean {
  return name.startsWith('ahrefs_')
}

type Cached = { value: unknown; cacheHit: boolean }
async function cached(tenant: TenantConfig, key: string, ttl: number, fetcher: () => Promise<unknown>): Promise<Cached> {
  return cachedJson({ pool, source: 'ahrefs', tenantId: tenant.tenantId, key, ttlSeconds: ttl, fetcher })
}

function out(r: Cached): string {
  const obj = (r.value && typeof r.value === 'object') ? r.value as Record<string, unknown> : { result: r.value }
  return JSON.stringify({ cacheHit: r.cacheHit, ...obj }, null, 2)
}

export async function executeAhrefsTool(
  name:   string,
  input:  Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  try {
    const limit   = Math.min(Number(input.limit) || 10, MAX_ROWS)
    const country = String(input.country || 'au')
    const target  = String(input.target || '')

    switch (name) {
      case 'ahrefs_domain_rating':
        if (!target) return `${name} error: target is required`
        return out(await cached(tenant, `dr:${target}`, TTL.DOMAIN_RATING,
          () => ahrefs.domainRating(target)))

      case 'ahrefs_backlinks': {
        if (!target) return `${name} error: target is required`
        const mode = String(input.mode || 'subdomains')
        return out(await cached(tenant, `backlinks:${mode}:${target}:${limit}`, TTL.BACKLINKS,
          () => ahrefs.backlinks(target, limit, mode)))
      }

      case 'ahrefs_referring_domains':
        if (!target) return `${name} error: target is required`
        return out(await cached(tenant, `refdomains:${target}:${limit}`, TTL.REF_DOMAINS,
          () => ahrefs.referringDomains(target, limit)))

      case 'ahrefs_backlink_gap': {
        const competitor = String(input.competitor || '')
        if (!competitor) return `${name} error: competitor is required`
        const ours = String(input.our_domain || tenant.targetDomain || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
        if (!ours) return `${name} error: our_domain not provided and tenant has no target_domain configured`
        const wanted = Math.min(Number(input.limit) || 15, MAX_ROWS)

        const [ourSide, theirSide] = await Promise.all([
          cached(tenant, `refdomains:${ours}:${GAP_OWN_SIDE_ROWS}`, TTL.REF_DOMAINS,
            () => ahrefs.referringDomains(ours, GAP_OWN_SIDE_ROWS)),
          cached(tenant, `refdomains:${competitor}:${GAP_OWN_SIDE_ROWS}`, TTL.REF_DOMAINS,
            () => ahrefs.referringDomains(competitor, GAP_OWN_SIDE_ROWS)),
        ])
        const domainsOf = (v: unknown): Array<Record<string, unknown>> => {
          const o = v as { refdomains?: Array<Record<string, unknown>>; domains?: Array<Record<string, unknown>> }
          return o?.refdomains ?? o?.domains ?? []
        }
        const ourSet = new Set(domainsOf(ourSide.value).map(d => String(d.domain)))
        const gap = domainsOf(theirSide.value)
          .filter(d => !ourSet.has(String(d.domain)))
          .slice(0, wanted)
        return JSON.stringify({
          competitor, our_domain: ours,
          cacheHit: ourSide.cacheHit && theirSide.cacheHit,
          gap_count: gap.length, prospects: gap,
          note: gap.length === 0 ? 'Empty gap can mean response shape drift — check raw refdomains output via ahrefs_referring_domains.' : undefined,
        }, null, 2)
      }

      case 'ahrefs_broken_backlinks':
        if (!target) return `${name} error: target is required`
        return out(await cached(tenant, `broken:${target}:${limit}`, TTL.BACKLINKS,
          () => ahrefs.brokenBacklinks(target, limit)))

      case 'ahrefs_organic_competitors':
        if (!target) return `${name} error: target is required`
        return out(await cached(tenant, `competitors:${target}:${country}:${limit}`, TTL.ORGANIC_KEYWORDS,
          () => ahrefs.organicCompetitors(target, limit, country)))

      case 'ahrefs_organic_keywords': {
        if (!target) return `${name} error: target is required`
        const mode = String(input.mode || 'subdomains')
        return out(await cached(tenant, `organic:${mode}:${target}:${country}:${limit}`, TTL.ORGANIC_KEYWORDS,
          () => ahrefs.organicKeywords(target, mode, country, limit)))
      }

      case 'ahrefs_top_pages':
        if (!target) return `${name} error: target is required`
        return out(await cached(tenant, `toppages:${target}:${country}:${limit}`, TTL.DOMAIN_RATING,
          () => ahrefs.topPages(target, limit, country)))

      case 'ahrefs_best_by_internal_links':
        if (!target) return `${name} error: target is required`
        return out(await cached(tenant, `internal:${target}:${limit}`, TTL.DOMAIN_RATING,
          () => ahrefs.bestByInternalLinks(target, limit)))

      case 'ahrefs_keyword_ideas': {
        const keyword = String(input.keyword || '').trim()
        if (!keyword) return `${name} error: keyword is required`
        return out(await cached(tenant, `ideas:${country}:${keyword}:${limit}`, TTL.KEYWORD_METRICS,
          () => ahrefs.keywordIdeas(keyword, country, limit)))
      }

      case 'ahrefs_keyword_metrics': {
        const keywords = String(input.keywords || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10).join(',')
        if (!keywords) return `${name} error: keywords is required`
        return out(await cached(tenant, `kwmetrics:${country}:${keywords}`, TTL.KEYWORD_METRICS,
          () => ahrefs.keywordMetrics(keywords, country)))
      }

      case 'ahrefs_serp_overview': {
        const keyword = String(input.keyword || '').trim()
        if (!keyword) return `${name} error: keyword is required`
        const top = Math.min(Number(input.top_positions) || 10, 10)
        return out(await cached(tenant, `serp:${country}:${keyword}:${top}`, TTL.SERP_OVERVIEW,
          () => ahrefs.serpOverview(keyword, country, top)))
      }

      default:
        return `Unknown Ahrefs tool: ${name}`
    }
  } catch (err) {
    return `${name} error: ${String(err).slice(0, 500)}`
  }
}
