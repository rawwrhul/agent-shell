// src/integrations/googleads/tools.ts
//
// Read-only Google Ads tools (auto-execute tier - no HITL). Each tool feeds
// one of the seven mutate action types coming in chunks 1b-1e:
//
//   Negatives          -> google_ads_search_terms (high-spend, low-conversion
//                         terms - the mining source; NOT high-CPC)
//   Bid changes        -> google_ads_campaign_overview (bidding strategy type
//                         decides the lever: raise tCPA / manual CPC for
//                         aggression, lower tROAS - inverse; Max Conversions
//                         routes aggression to budget instead)
//   Budget changes     -> google_ads_campaign_overview (diagnose IS type
//                         first: lost-to-budget -> budget, lost-to-rank ->
//                         bids, both maxed -> hold)
//   Ad copy            -> google_ads_ads (current RSA assets to improve on)
//   Keyword edit/add   -> google_ads_keywords (top performers = expansion
//                         targets; match types for editing)
//
// All money values are converted from micros to account-currency units
// before reaching the agent. No raw micros ever enter a prompt.
//
// GAQL injection discipline: the only user-controllable inputs interpolated
// into queries are integers (limit, campaign id) sanitised via num().

import type Anthropic from '@anthropic-ai/sdk'
import { fromMicros } from 'google-ads-api'
import type { TenantConfig } from '../../tenants/types'
import { forTenant } from './client'

const MAX_ROWS = 50

export const GOOGLE_ADS_TOOLS: Anthropic.Tool[] = [
  {
    name: 'google_ads_campaign_overview',
    description:
      'Enabled campaigns with spend, conversions, bidding strategy type, daily budget, and impression share lost to budget vs rank (last 30 days). Use this FIRST for any bid or budget decision: lost IS to budget means raise budget, lost IS to rank means raise bids, both near zero with spend under budget means hold.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `Max campaigns (default 20, cap ${MAX_ROWS})` },
      },
    },
  },
  {
    name: 'google_ads_search_terms',
    description:
      'Search terms by spend descending with clicks, conversions, and cost (last 30 days). The mining source for negative keywords: target HIGH-SPEND LOW-CONVERSION terms, not high-CPC ones. Optionally filter to one campaign.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'number', description: 'Optional campaign id to filter' },
        limit:       { type: 'number', description: `Max rows (default 25, cap ${MAX_ROWS})` },
      },
    },
  },
  {
    name: 'google_ads_keywords',
    description:
      'Active keywords with match type, quality score, spend, conversions, and average CPC (last 30 days). Top performers on strong campaigns are the expansion targets; match types inform keyword-editing proposals. Optionally filter to one campaign.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'number', description: 'Optional campaign id to filter' },
        limit:       { type: 'number', description: `Max rows (default 25, cap ${MAX_ROWS})` },
      },
    },
  },
  {
    name: 'google_ads_ads',
    description:
      'Enabled responsive search ads with their headlines, descriptions, final URLs, and performance (last 30 days). The current-copy baseline for ad copy proposals. Optionally filter to one campaign.',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'number', description: 'Optional campaign id to filter' },
        limit:       { type: 'number', description: `Max ads (default 15, cap ${MAX_ROWS})` },
      },
    },
  },
]

const TOOL_NAMES = new Set(GOOGLE_ADS_TOOLS.map((t) => t.name))

export function isGoogleAdsToolName(name: string): boolean {
  return TOOL_NAMES.has(name)
}

export async function executeGoogleAdsTool(
  name:   string,
  input:  Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  try {
    const client = await forTenant(tenant.tenantId)
    const limit = limitNum(input.limit, name === 'google_ads_campaign_overview' ? 20 : name === 'google_ads_ads' ? 15 : 25)
    const campaignId = idNum(input.campaign_id)
    const campaignFilter = campaignId ? ` AND campaign.id = ${campaignId}` : ''

    switch (name) {
      case 'google_ads_campaign_overview': {
        const rows = await client.query(`
          SELECT campaign.id, campaign.name, campaign.status,
                 campaign.advertising_channel_type, campaign.bidding_strategy_type,
                 campaign_budget.amount_micros,
                 metrics.cost_micros, metrics.clicks, metrics.impressions,
                 metrics.conversions, metrics.conversions_value,
                 metrics.search_impression_share,
                 metrics.search_budget_lost_impression_share,
                 metrics.search_rank_lost_impression_share
          FROM campaign
          WHERE campaign.status = 'ENABLED' AND segments.date DURING LAST_30_DAYS
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}`, 'campaign_overview')
        return out(rows.map((r) => ({
          id:                 r.campaign?.id,
          name:               r.campaign?.name,
          channel:            r.campaign?.advertising_channel_type,
          bidding_strategy:   r.campaign?.bidding_strategy_type,
          daily_budget:       money(r.campaign_budget?.amount_micros),
          cost:               money(r.metrics?.cost_micros),
          clicks:             r.metrics?.clicks,
          impressions:        r.metrics?.impressions,
          conversions:        r.metrics?.conversions,
          conversions_value:  round2(r.metrics?.conversions_value),
          search_is:          pct(r.metrics?.search_impression_share),
          is_lost_to_budget:  pct(r.metrics?.search_budget_lost_impression_share),
          is_lost_to_rank:    pct(r.metrics?.search_rank_lost_impression_share),
        })))
      }

      case 'google_ads_search_terms': {
        const rows = await client.query(`
          SELECT search_term_view.search_term, campaign.id, campaign.name, ad_group.id, ad_group.name,
                 metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
          FROM search_term_view
          WHERE segments.date DURING LAST_30_DAYS${campaignFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}`, 'search_terms')
        return out(rows.map((r) => ({
          term:        r.search_term_view?.search_term,
          campaign:    r.campaign?.name,
          campaign_id: r.campaign?.id,
          ad_group:    r.ad_group?.name,
          ad_group_id: r.ad_group?.id,
          cost:        money(r.metrics?.cost_micros),
          clicks:      r.metrics?.clicks,
          impressions: r.metrics?.impressions,
          conversions: r.metrics?.conversions,
        })))
      }

      case 'google_ads_keywords': {
        const rows = await client.query(`
          SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                 ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                 ad_group_criterion.quality_info.quality_score,
                 campaign.id, campaign.name, ad_group.id, ad_group.name,
                 metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.average_cpc
          FROM keyword_view
          WHERE segments.date DURING LAST_30_DAYS
            AND ad_group_criterion.status IN ('ENABLED', 'PAUSED')${campaignFilter}
          ORDER BY metrics.cost_micros DESC
          LIMIT ${limit}`, 'keywords')
        return out(rows.map((r) => ({
          keyword:       r.ad_group_criterion?.keyword?.text,
          match_type:    r.ad_group_criterion?.keyword?.match_type,
          status:        r.ad_group_criterion?.status,
          quality_score: r.ad_group_criterion?.quality_info?.quality_score,
          campaign:      r.campaign?.name,
          campaign_id:   r.campaign?.id,
          ad_group:      r.ad_group?.name,
          ad_group_id:   r.ad_group?.id,
          criterion_id:  r.ad_group_criterion?.criterion_id,
          cost:          money(r.metrics?.cost_micros),
          clicks:        r.metrics?.clicks,
          conversions:   r.metrics?.conversions,
          avg_cpc:       money(r.metrics?.average_cpc),
        })))
      }

      case 'google_ads_ads': {
        const rows = await client.query(`
          SELECT ad_group_ad.ad.id, ad_group_ad.status,
                 ad_group_ad.ad.responsive_search_ad.headlines,
                 ad_group_ad.ad.responsive_search_ad.descriptions,
                 ad_group_ad.ad.final_urls,
                 campaign.id, campaign.name, ad_group.id, ad_group.name,
                 metrics.impressions, metrics.clicks, metrics.conversions
          FROM ad_group_ad
          WHERE ad_group_ad.status = 'ENABLED'
            AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD'
            AND segments.date DURING LAST_30_DAYS${campaignFilter}
          ORDER BY metrics.impressions DESC
          LIMIT ${limit}`, 'ads')
        return out(rows.map((r) => ({
          ad_id:        r.ad_group_ad?.ad?.id,
          campaign:     r.campaign?.name,
          campaign_id:  r.campaign?.id,
          ad_group:     r.ad_group?.name,
          ad_group_id:  r.ad_group?.id,
          headlines:    (r.ad_group_ad?.ad?.responsive_search_ad?.headlines ?? []).map((h) => h?.text),
          descriptions: (r.ad_group_ad?.ad?.responsive_search_ad?.descriptions ?? []).map((d) => d?.text),
          final_urls:   r.ad_group_ad?.ad?.final_urls,
          impressions:  r.metrics?.impressions,
          clicks:       r.metrics?.clicks,
          conversions:  r.metrics?.conversions,
        })))
      }

      default:
        return `Unknown Google Ads tool: ${name}`
    }
  } catch (err) {
    return `${name} error: ${String(err).slice(0, 500)}`
  }
}

function limitNum(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(n, MAX_ROWS)
}

function idNum(v: unknown): number | null {
  if (v == null) return null
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? n : null
}

function money(micros: unknown): number | null {
  if (micros == null) return null
  return round2(fromMicros(Number(micros)))
}

function pct(v: unknown): number | null {
  if (v == null) return null
  return Math.round(Number(v) * 1000) / 10
}

function round2(v: unknown): number | null {
  if (v == null) return null
  return Math.round(Number(v) * 100) / 100
}

function out(data: unknown): string {
  return JSON.stringify(data)
}
