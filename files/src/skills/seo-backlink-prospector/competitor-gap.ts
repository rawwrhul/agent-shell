// src/skills/seo-backlink-prospector/competitor-gap.ts
//
// Diff competitor backlinks against our inventory to identify prospects.
// For each competitor in tenants.competitor_domains, pull their backlinks
// via DataForSEO and produce ranked candidates we don't have.

import type { TenantConfig } from '../../tenants/types'
import { backlinksList } from '../../integrations/dataforseo/client'
import { logger } from '../../logger'
import { getReferringDomainSet } from './store'
import {
  BacklinkProspect, MIN_PROSPECT_DR, REQUIRE_NEW_DOMAIN,
  MAX_PROSPECTS_PER_CYCLE,
} from './types'

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
      const rows = await backlinksList(input.tenant, {
        target: competitor,
        limit:  100,
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
