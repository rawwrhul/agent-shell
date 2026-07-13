// src/skills/seo-backlink-prospector/competitor-gap.ts
//
// Diff competitor backlinks against our inventory to identify prospects.
// For each competitor in tenants.competitor_domains, pull their backlinks
// and produce ranked candidates we don't have.
//
// SOURCE PRIORITY: Ahrefs first (materially better link index — prospect
// quality is bounded by index quality), DataForSEO as fallback when Ahrefs
// is unconfigured, errors, or returns an unrecognizable shape. Ahrefs
// responses are mapped defensively (field names vary across plans/versions)
// and cached via cache_entries — Ahrefs bills per row.

import type { TenantConfig } from '../../tenants/types'
import { backlinksList } from '../../integrations/dataforseo/client'
import { backlinks as ahrefsBacklinks } from '../../integrations/ahrefs/client'
import { cachedJson, TTL } from '../../core/cache/cached-fetch'
import { pool } from '../../memory/postgres'
import { logger } from '../../logger'
import { getReferringDomainSet } from './store'
import {
  BacklinkProspect, MIN_PROSPECT_DR, REQUIRE_NEW_DOMAIN,
  MAX_PROSPECTS_PER_CYCLE,
} from './types'

// Common row shape both sources map into (matches the DataForSEO fields the
// scoring below was built on).
interface GapRow {
  source_url:    string
  source_domain: string
  source_rank:   number | null
  anchor:        string | null
  dofollow:      boolean | null
  target_url:    string | null
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' }
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Defensive mapping of an Ahrefs backlinks response to GapRow[]. Exported for tests. */
export function mapAhrefsBacklinkRows(res: unknown): GapRow[] {
  if (!res || typeof res !== 'object') return []
  const o = res as Record<string, unknown>
  const arr = (o.backlinks ?? o.items ?? o.rows) as Array<Record<string, unknown>> | undefined
  if (!Array.isArray(arr)) return []

  const rows: GapRow[] = []
  for (const r of arr) {
    const sourceUrl = String(r.url_from ?? r.source_url ?? r.url ?? '')
    if (!sourceUrl) continue
    const sourceDomain = String(r.domain_from ?? r.source_domain ?? '') || hostnameOf(sourceUrl)
    if (!sourceDomain) continue
    rows.push({
      source_url:    sourceUrl,
      source_domain: sourceDomain,
      source_rank:   num(r.domain_rating_source ?? r.domain_rating ?? r.source_rank ?? r.dr),
      anchor:        typeof r.anchor === 'string' ? r.anchor : null,
      dofollow:      typeof r.is_dofollow === 'boolean' ? r.is_dofollow
                     : typeof r.dofollow === 'boolean' ? r.dofollow
                     : typeof r.is_nofollow === 'boolean' ? !r.is_nofollow
                     : null,
      target_url:    typeof r.url_to === 'string' ? r.url_to
                     : typeof r.target_url === 'string' ? r.target_url : null,
    })
  }
  return rows
}

/**
 * Pull one competitor's backlinks: Ahrefs first (cached), DataForSEO
 * fallback. Returns the rows plus which source produced them (for logs).
 */
async function fetchCompetitorBacklinks(
  tenant: TenantConfig, competitor: string,
): Promise<{ rows: GapRow[]; source: 'ahrefs' | 'dataforseo' }> {
  try {
    const { value } = await cachedJson({
      pool, source: 'ahrefs', tenantId: tenant.tenantId,
      key: `prospect-backlinks:${competitor}:100`, ttlSeconds: TTL.BACKLINKS,
      fetcher: () => ahrefsBacklinks(competitor, 100, 'subdomains'),
    })
    const rows = mapAhrefsBacklinkRows(value)
    if (rows.length > 0) return { rows, source: 'ahrefs' }
    logger.info('backlink_gap_ahrefs_empty_falling_back', {
      tenantId: tenant.tenantId, competitor,
      hint: 'No rows mapped from Ahrefs response — unconfigured key, empty index, or shape drift. Using DataForSEO.',
    })
  } catch (err) {
    logger.info('backlink_gap_ahrefs_unavailable', {
      tenantId: tenant.tenantId, competitor, err: String(err).slice(0, 200),
    })
  }

  const dfsRows = await backlinksList(tenant, { target: competitor, limit: 100 })
  return {
    rows: dfsRows.map(r => ({
      source_url:    r.source_url,
      source_domain: r.source_domain,
      source_rank:   r.source_rank ?? null,
      anchor:        r.anchor ?? null,
      dofollow:      r.dofollow ?? null,
      target_url:    r.target_url ?? null,
    })),
    source: 'dataforseo',
  }
}

export async function findCompetitorGapProspects(input: {
  tenant: TenantConfig
}): Promise<{ competitorsScanned: number; prospects: BacklinkProspect[] }> {
  const competitors: string[] = input.tenant.competitorDomains ?? []
  if (competitors.length === 0) {
    logger.info('backlink_gap_no_competitors_configured', {
      tenantId: input.tenant.tenantId,
    })
    return { competitorsScanned: 0, prospects: [] }
  }

  const ourReferringDomains = await getReferringDomainSet(input.tenant.tenantId)
  const ourDomain = input.tenant.targetDomain ?? ''

  const allProspects: BacklinkProspect[] = []
  let competitorsScanned = 0

  for (const competitor of competitors) {
    try {
      const { rows, source } = await fetchCompetitorBacklinks(input.tenant, competitor)
      logger.info('backlink_gap_source_used', {
        tenantId: input.tenant.tenantId, competitor, source, rows: rows.length,
      })
      competitorsScanned++

      for (const r of rows) {
        // Skip if we already have a link from this domain.
        if (REQUIRE_NEW_DOMAIN && ourReferringDomains.has(r.source_domain)) continue
        // Skip ourselves linking to a competitor (we wouldn't ask ourselves).
        if (r.source_domain === ourDomain) continue
        // Skip the competitor self-linking.
        if (r.source_domain === competitor) continue
        // DR floor.
        const dr = r.source_rank ?? 0
        if (dr < MIN_PROSPECT_DR) continue

        const prospectScore = scoreProspect({
          sourceDr:   dr,
          dofollow:   r.dofollow ?? true,
          anchorText: r.anchor ?? null,
        })

        allProspects.push({
          sourceUrl:           r.source_url,
          sourceDomain:        r.source_domain,
          sourceDr:            dr,
          anchorText:          r.anchor ?? null,
          competitorDomain:    competitor,
          competitorTargetUrl: r.target_url ?? competitor,
          prospectScore,
          rationale: buildRationale({
            competitor, dr, anchor: r.anchor ?? null,
          }),
        })
      }
    } catch (err) {
      logger.warn('backlink_gap_competitor_fetch_failed', {
        tenantId: input.tenant.tenantId, competitor,
        err:      String(err).slice(0, 200),
      })
    }
  }

  // Deduplicate on source_domain — only one prospect per referring domain
  // per cycle, keep the highest-scored.
  const byDomain = new Map<string, BacklinkProspect>()
  for (const p of allProspects) {
    const existing = byDomain.get(p.sourceDomain)
    if (!existing || existing.prospectScore < p.prospectScore) {
      byDomain.set(p.sourceDomain, p)
    }
  }

  const ranked = Array.from(byDomain.values())
    .sort((a, b) => b.prospectScore - a.prospectScore)
    .slice(0, MAX_PROSPECTS_PER_CYCLE)

  return { competitorsScanned, prospects: ranked }
}

// ── Scoring ─────────────────────────────────────────────────────────────

function scoreProspect(input: {
  sourceDr:   number
  dofollow:   boolean
  anchorText: string | null
}): number {
  // DR contribution: 0–0.6 (linear from MIN_PROSPECT_DR to 90).
  const drScore = Math.min(0.6,
    0.6 * (input.sourceDr - MIN_PROSPECT_DR) / (90 - MIN_PROSPECT_DR))
  // Dofollow contribution: 0.25 if dofollow, 0.0 if nofollow.
  const dofollowScore = input.dofollow ? 0.25 : 0
  // Anchor relevance: 0.15 if anchor exists and isn't generic.
  const anchorScore = input.anchorText
    && !isGenericAnchor(input.anchorText) ? 0.15 : 0
  return Math.max(0, Math.min(1, drScore + dofollowScore + anchorScore))
}

function isGenericAnchor(anchor: string): boolean {
  const a = anchor.trim().toLowerCase()
  return ['', 'here', 'click here', 'this', 'link', 'read more', 'website'].includes(a)
}

function buildRationale(input: {
  competitor: string
  dr:         number
  anchor:     string | null
}): string {
  return `${input.competitor} earned a backlink from this DR-${input.dr} domain` +
    (input.anchor ? ` with anchor "${input.anchor}".` : '.')
}
