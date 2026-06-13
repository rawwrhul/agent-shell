// src/core/strategy/refresh.ts
//
// Phase 2, build unit 2: the strategy_refresh cycle. Deterministic-shell,
// LLM-authored: it GATHERS signals, the LLM SETS DIRECTION (portfolio
// dispositions, competitive fronts, constraints, prose brief), and we persist
// a new version + push dispositions onto seo_clusters. The LLM never touches
// EV numbers — those stay in the deterministic scorer (unit 1).
//
// Cadence: the cron fires weekly but this no-ops if the latest doc is younger
// than STRATEGY_MIN_AGE_DAYS unless forced (CLI / onboarding bootstrap) — an
// effective fortnightly without cron gymnastics.
//
// v1 authors from in-DB signals (performance history, clusters, memory) plus
// business + competitor context. Live Ahrefs/DataForSEO/Surfer enrichment is
// the 2b pass — see GATHER VENDOR HOOK below. Everything is best-effort: a
// cold-start tenant with no history/clusters/memory still produces a v1 doc.

import Anthropic from '@anthropic-ai/sdk'
import { pool } from '../../memory/postgres'
import { config } from '../../config'
import { logger } from '../../logger'
import { callAnthropic } from '../../lib/anthropic-call'
import { getTenant } from '../../tenants/registry'
import { executeMetricsTool } from '../metrics/tools'
import { listClusters } from '../../seo/data-store'
import { queryMemory } from '../../memory/runtime'
import { normalizeStrategyCore } from './normalize'
import { saveStrategyDoc, getLatestStrategy, applyClusterDispositions } from './store'
import { STRATEGY_MIN_AGE_DAYS, CLUSTER_DISPOSITIONS } from './types'

export interface StrategyRefreshOpts {
  /** Bypass the freshness guard (CLI / onboarding bootstrap). */
  force?:     boolean
  /** Force cold-start framing in the prompt; defaults to "no prior version". */
  coldStart?: boolean
}

export interface StrategyRefreshResult {
  tenantId:        string
  version?:        number
  skipped?:        boolean
  reason?:         string
  warnings?:       string[]
  clustersUpdated?: number
}

export async function runStrategyRefreshCycle(
  tenantId: string,
  opts: StrategyRefreshOpts = {},
): Promise<StrategyRefreshResult> {
  logger.info('strategy_refresh_starting', { tenantId, force: !!opts.force })

  const latest = await safe(() => getLatestStrategy(tenantId))
  if (!opts.force && latest) {
    const ageDays = (Date.now() - new Date(latest.generatedAt).getTime()) / 86_400_000
    if (ageDays < STRATEGY_MIN_AGE_DAYS) {
      logger.info('strategy_refresh_skipped_fresh', { tenantId, ageDays: Math.round(ageDays) })
      return { tenantId, skipped: true, reason: 'fresh' }
    }
  }

  let tenant: Awaited<ReturnType<typeof getTenant>>
  try {
    tenant = await getTenant(tenantId)
  } catch (err) {
    logger.error('strategy_refresh_tenant_load_failed', { tenantId, err: String(err).slice(0, 200) })
    return { tenantId, skipped: true, reason: 'tenant_not_found' }
  }

  // ── Gather (best-effort) ───────────────────────────────────────────────
  const perf    = await safe(() => executeMetricsTool('metrics_performance_summary', { days: 28 }, tenantId))
  const movers  = await safe(() => executeMetricsTool('metrics_top_movers', { days: 28, limit: 8 }, tenantId))
  const clusters = (await safe(() => listClusters(pool, tenantId))) ?? []
  const memories = (await safe(() => queryMemory({ tenantId, limit: 25 }))) ?? []

  // Demonstrated demand: the queries the site already ranks for (in-DB GSC,
  // query grain). The summary/movers tools above are aggregate; without this
  // the strategist authors the portfolio blind to what the site actually holds
  // and misses commercial head terms already ranking. Brand terms filtered out.
  const rankingSurface = (await safe(() => gatherRankingSurface(tenantId, brandTokens(tenant)))) ?? ''

  // GATHER VENDOR HOOK (2b): live Ahrefs organic_competitors / backlink_gap,
  // DataForSEO SERP, Surfer content guidelines per priority cluster — all via
  // cachedJson under the per-sweep unit budget. Wired + gather-tested in 2b.
  const vendorContext = ''

  const coldStart = opts.coldStart ?? (latest === null)

  // ── Author ─────────────────────────────────────────────────────────────
  const prompt = buildStrategyPrompt({
    clientName:  tenant.clientName,
    domain:      tenant.targetDomain ?? undefined,
    competitors: tenant.competitorDomains ?? [],
    brief:       tenant.businessBrief ?? undefined,
    perf, movers,
    clusterLines: clusters.map((c) => `- ${c.pillarTopic} (${c.state})`).join('\n'),
    memoryLines:  memories.map((m) => `- [${m.type}/${m.key}] ${m.value}`).join('\n'),
    rankingSurfaceLines: rankingSurface,
    vendorContext, coldStart,
  })

  let text = ''
  try {
    const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
    const resp = await callAnthropic(client, {
      model:      tenant.agentModel ?? config.AGENT_MODEL,
      max_tokens: 4000,
      messages:   [{ role: 'user', content: prompt }],
    }, { label: 'strategy-refresh' })
    text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
  } catch (err) {
    logger.error('strategy_refresh_author_failed', { tenantId, err: String(err).slice(0, 300) })
    return { tenantId, skipped: true, reason: 'author_failed' }
  }

  const parsed = extractJson(text)
  const { core, warnings } = normalizeStrategyCore(parsed?.core)
  const brief = typeof parsed?.brief === 'string' && parsed.brief.trim()
    ? parsed.brief.trim()
    : text.slice(0, 4000)

  // ── Persist ────────────────────────────────────────────────────────────
  const version = await saveStrategyDoc({ tenantId, core, brief, coldStart })
  const clustersUpdated = await applyClusterDispositions(tenantId, core.portfolio)

  logger.info('strategy_refresh_completed', {
    tenantId, version, coldStart,
    portfolio: core.portfolio.length, fronts: core.fronts.length,
    constraints: core.constraints.length, clustersUpdated,
    warnings: warnings.length,
  })
  return { tenantId, version, warnings, clustersUpdated }
}

// ── prompt ───────────────────────────────────────────────────────────────

function buildStrategyPrompt(p: {
  clientName:   string
  domain?:      string
  competitors:  string[]
  brief?:       string
  perf:         string | null
  movers:       string | null
  clusterLines: string
  memoryLines:  string
  rankingSurfaceLines: string
  vendorContext: string
  coldStart:    boolean
}): string {
  const dispositions = CLUSTER_DISPOSITIONS.join(' | ')
  return [
    `You are the SEO strategist for ${p.clientName}${p.domain ? ` (${p.domain})` : ''}.`,
    `Produce a directional SEO strategy. You set DIRECTION only — do not estimate traffic numbers or impact; a separate deterministic engine scores individual opportunities.`,
    p.coldStart
      ? `This is a COLD START: little or no outcome history exists yet. Lean on the business context, competitor set, and any landscape data. Be explicit where you are inferring.`
      : `Refine the prior strategy against the latest signals.`,
    ``,
    `Business brief:\n${p.brief ?? '(none provided)'}`,
    ``,
    `Known competitors: ${p.competitors.length ? p.competitors.join(', ') : '(none configured)'}`,
    ``,
    `Recent organic performance (28d vs prior, from stored GSC/GA4):\n${p.perf ?? '(no history yet)'}`,
    ``,
    `Top movers:\n${p.movers ?? '(no history yet)'}`,
    ``,
    `Queries the site ALREADY ranks for (GSC, last 28d, brand terms excluded). GROUND THE PORTFOLIO IN THESE: form or defend clusters around demonstrated demand, especially commercial-intent head terms the site already holds or sits close on. Do not omit a category the site clearly ranks for:\n${p.rankingSurfaceLines || '(no ranking data yet)'}`,
    ``,
    `Existing clusters:\n${p.clusterLines || '(none defined yet)'}`,
    ``,
    `What we have learned (memory — honour constraints, do not re-chase losses):\n${p.memoryLines || '(none yet)'}`,
    p.vendorContext ? `\nLandscape data:\n${p.vendorContext}` : ``,
    ``,
    `Return ONLY a JSON object, no preamble, no markdown fences:`,
    `{`,
    `  "core": {`,
    `    "portfolio": [ { "topic": string, "disposition": ${dispositions}, "priority": number (1=highest), "targetKeywords": string[], "rationale": string } ],`,
    `    "fronts": [ { "competitor": string, "where": string, "winnable": boolean, "note": string } ],`,
    `    "constraints": [ { "kind": "voice"|"no_go"|"decision"|"learning", "value": string } ]`,
    `  },`,
    `  "brief": "2-4 short paragraphs: current position, the thesis for this period, the top 2-3 bets, and what we are deliberately NOT doing."`,
    `}`,
  ].join('\n')
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Brand tokens to strip from the ranking surface (client name + domain SLD). */
function brandTokens(tenant: { clientName: string; targetDomain?: string | null }): string[] {
  const toks = new Set<string>()
  for (const t of tenant.clientName.toLowerCase().split(/\s+/)) if (t.length >= 3) toks.add(t)
  if (tenant.targetDomain) {
    const host = tenant.targetDomain.replace(/^https?:\/\//, '').replace(/^sc-domain:/, '').split('/')[0]
    const sld = host.split('.')[0]
    if (sld && sld.length >= 3) toks.add(sld.toLowerCase())
  }
  return [...toks]
}

/** Top non-brand queries the site ranks for, formatted for the strategist. */
async function gatherRankingSurface(tenantId: string, brand: string[]): Promise<string> {
  const res = await pool.query(
    `SELECT keyword,
            SUM(impressions)::int impr,
            SUM(clicks)::int clicks,
            SUM(position*impressions)/NULLIF(SUM(impressions),0) pos
     FROM ranking_history
     WHERE tenant_id=$1 AND date >= CURRENT_DATE - 28
     GROUP BY keyword
     HAVING SUM(impressions) >= 2
     ORDER BY impr DESC
     LIMIT 60`,
    [tenantId],
  )
  const rows = res.rows
    .map((r) => ({ keyword: String(r.keyword), impr: Number(r.impr), clicks: Number(r.clicks), pos: Number(r.pos) }))
    .filter((r) => {
      const k = r.keyword.toLowerCase()
      return !brand.some((b) => k.includes(b))
    })
    .slice(0, 40)
  if (!rows.length) return ''
  return rows
    .map((r) => `- "${r.keyword}" — #${r.pos.toFixed(1)}, ${r.impr} impr, ${r.clicks} clicks`)
    .join('\n')
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}

function extractJson(text: string): { core?: unknown; brief?: unknown } | null {
  const tryParse = (s: string) => { try { return JSON.parse(s) } catch { return null } }
  let parsed = tryParse(text)
  if (parsed) return parsed
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
  parsed = tryParse(stripped)
  if (parsed) return parsed
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    parsed = tryParse(text.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}
