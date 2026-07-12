// src/skills/seo/cannibalization.ts
//
// Server-side cannibalization guard for new article pitches. At 2 posts/day,
// the biggest content risk is two pages chasing the same query cluster:
// authority splits, both rank worse, and the site starts reading as thin.
//
// Three deterministic checks against data we already hold (no LLM):
//   1. Slug collision — the exact CMS path already exists in the crawl
//      inventory (seo_page_inventory).
//   2. Title near-duplicate — normalized token Jaccard vs every crawled
//      title. Catches "Offshore Teams Guide 2026" vs "Guide to Offshore
//      Teams" style overlap that exact matching misses.
//   3. Target-keyword overlap — an existing page already earns meaningful
//      GSC impressions for the pitch's target keyword at a workable
//      position (ranking_history, last 28 days). The right move there is
//      improving THAT page, not launching a competitor to it.
//
// FAIL-OPEN on missing data: a tenant with no crawl rows or no GSC history
// simply skips the affected check. The guard blocks on positive evidence
// of overlap, never on absence of data.

import type { Pool } from 'pg'
import { logger } from '../../logger'

const TITLE_SIMILARITY_THRESHOLD = 0.6
const KEYWORD_MIN_IMPRESSIONS    = 50
const KEYWORD_MAX_POSITION       = 20
const KEYWORD_WINDOW_DAYS        = 28

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'to', 'for', 'in', 'on', 'with', 'your',
  'how', 'what', 'why', 'when', 'is', 'are', 'vs', 'guide', 'complete', 'ultimate',
  '2024', '2025', '2026', '2027',
])

export function normalizeTitleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t)),
  )
}

/** Jaccard similarity over normalized, stopword-stripped title tokens. */
export function titleSimilarity(a: string, b: string): number {
  const ta = normalizeTitleTokens(a)
  const tb = normalizeTitleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  for (const t of ta) if (tb.has(t)) intersection++
  const union = ta.size + tb.size - intersection
  return union === 0 ? 0 : intersection / union
}

export interface CannibalizationInput {
  tenantId:       string
  slug:           string
  title:          string
  targetKeyword?: string
  cmsPrefix:      string
}

/**
 * Returns a list of blocking error strings (empty = clear to file).
 * Each error is written to be actionable for the agent: what collided,
 * with which page, and what to do instead.
 */
export async function checkCannibalization(
  pool: Pool, input: CannibalizationInput,
): Promise<string[]> {
  const errors: string[] = []
  const slug = input.slug.trim().replace(/^\/+|\/+$/g, '')
  const prefix = input.cmsPrefix.endsWith('/') ? input.cmsPrefix : `${input.cmsPrefix}/`
  const path = `${prefix}${slug}`

  // 1 + 2: slug collision and title near-duplicates from the crawl inventory.
  try {
    const { rows } = await pool.query<{ url: string; title: string | null }>(
      `SELECT url, title FROM seo_page_inventory
        WHERE tenant_id = $1 AND http_status BETWEEN 200 AND 299`,
      [input.tenantId],
    )
    for (const row of rows) {
      const rowPath = pathOf(row.url)
      if (rowPath === path || rowPath === `${path}/`) {
        errors.push(
          `CANNIBALIZATION: slug '${slug}' already exists on the site (${row.url}). Pick a different slug — or if you meant to improve that page, use framer_update_blog_body / framer_update_blog_meta instead of a new post.`,
        )
        break
      }
    }
    if (input.title) {
      for (const row of rows) {
        if (!row.title) continue
        const sim = titleSimilarity(input.title, row.title)
        if (sim >= TITLE_SIMILARITY_THRESHOLD) {
          errors.push(
            `CANNIBALIZATION: proposed title '${input.title}' overlaps an existing page — '${row.title}' (${row.url}, similarity ${Math.round(sim * 100)}%). Two pages on the same topic split authority and both rank worse. Pick a genuinely different topic, or improve the existing page instead.`,
          )
          break
        }
      }
    }
  } catch (err) {
    logger.info('cannibalization_inventory_check_skipped', {
      tenantId: input.tenantId, err: String(err).slice(0, 200),
    })
  }

  // 3: target-keyword overlap from GSC history.
  const kw = (input.targetKeyword ?? '').trim().toLowerCase()
  if (kw) {
    try {
      const { rows } = await pool.query<{ page_url: string; impressions: string; pos: string | null }>(
        `SELECT page_url,
                SUM(impressions) AS impressions,
                CASE WHEN SUM(impressions) > 0
                     THEN SUM(position * impressions) / SUM(impressions)
                END AS pos
           FROM ranking_history
          WHERE tenant_id = $1 AND LOWER(keyword) = $2
            AND date >= NOW()::date - $3::int
          GROUP BY page_url
          ORDER BY SUM(impressions) DESC
          LIMIT 1`,
        [input.tenantId, kw, KEYWORD_WINDOW_DAYS],
      )
      const top = rows[0]
      if (top) {
        const impressions = Number(top.impressions)
        const pos = top.pos !== null ? Number(top.pos) : null
        const topPath = pathOf(top.page_url)
        const isSelf = topPath === path || topPath === `${path}/`
        if (!isSelf && impressions >= KEYWORD_MIN_IMPRESSIONS && pos !== null && pos <= KEYWORD_MAX_POSITION) {
          errors.push(
            `CANNIBALIZATION: '${top.page_url}' already ranks for target keyword '${kw}' (position ${pos.toFixed(1)}, ${impressions} impressions in the last ${KEYWORD_WINDOW_DAYS} days). A new post on this keyword competes with our own page. Either target a meaningfully different query cluster, or file a framer_update_blog_body improvement to the ranking page instead.`,
          )
        }
      }
    } catch (err) {
      logger.info('cannibalization_keyword_check_skipped', {
        tenantId: input.tenantId, err: String(err).slice(0, 200),
      })
    }
  }

  return errors
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.startsWith('/') ? url : `/${url}`
  }
}
