// src/skills/seo/edit-gates.ts
//
// Deterministic pre-flight gates for NON-ARTICLE live-site edits. Articles
// get the Surfer quality pipeline; until now meta rewrites, body edits and
// link inserts shipped with no server-side check at all. These gates run at
// propose_action time for FULL-AUTONOMY tenants only (HITL tenants keep a
// human eyeball; their behaviour is unchanged).
//
// Checks (all deterministic, no LLM):
//   input bounds     — title 30-65 chars, meta description 70-165, no
//                      generic anchor text on internal links
//   duplicate title  — new title must not collide with another page's
//                      (seo_page_inventory, normalized-token similarity)
//   link target      — internal-link target must exist in the crawl
//                      inventory (when inventory data exists)
//   protect winners  — a page whose clicks rose ≥25% (and ≥10 clicks) in
//                      the last 14 days vs the prior 14 is WORKING; content
//                      changes to it are blocked. Don't churn winners.
//   churn cap        — max 2 executed edits per page per 30 days. Repeated
//                      rewrites of one page look like flailing to Google
//                      and to the client.
//
// FAIL-OPEN on missing data (no crawl rows, no GSC history → skip that
// check). Blocks only on positive evidence.

import type { Pool } from 'pg'
import { logger } from '../../logger'
import { titleSimilarity } from './cannibalization'

const TITLE_MIN = 30
const TITLE_MAX = 65
const DESC_MIN  = 70
const DESC_MAX  = 165
const DUP_TITLE_SIMILARITY = 0.8
const WINNER_MIN_CLICKS    = 10
const WINNER_RISE_RATIO    = 1.25
const CHURN_CAP            = 2
const CHURN_WINDOW_DAYS    = 30
const GENERIC_ANCHORS = new Set([
  'click here', 'here', 'read more', 'learn more', 'this', 'this post',
  'this article', 'link', 'more',
])

/** Tools these gates apply to. */
export const EDIT_GATE_TOOLS = new Set([
  'framer_update_blog_meta',
  'framer_update_blog_body',
  'framer_add_blog_alt_text',
  'framer_add_internal_link',
  'framer_update_marketing_page_text',
  'webflow_update_blog_meta',
  'webflow_update_blog_body',
  'webflow_add_blog_alt_text',
  'webflow_add_internal_link',
  'webflow_update_marketing_page_text',
  'webflow_update_page_meta',
])

// Content-changing tools subject to protect-winners. Alt text and added
// internal links are low-risk/additive — exempt.
const CONTENT_CHANGE_TOOLS = new Set([
  'framer_update_blog_meta',
  'framer_update_blog_body',
  'framer_update_marketing_page_text',
  'webflow_update_blog_meta',
  'webflow_update_blog_body',
  'webflow_update_marketing_page_text',
  'webflow_update_page_meta',
])

export interface EditGateInput {
  tenantId:  string
  toolName:  string
  toolInput: Record<string, unknown>
  cmsPrefix: string
}

export function targetPathOf(toolName: string, toolInput: Record<string, unknown>, cmsPrefix: string): string | null {
  const prefix = cmsPrefix.endsWith('/') ? cmsPrefix : `${cmsPrefix}/`
  const slug = typeof toolInput.slug === 'string' ? toolInput.slug.trim().replace(/^\/+|\/+$/g, '') : ''
  if (slug) return `${prefix}${slug}`
  const p = typeof toolInput.pagePath === 'string' ? toolInput.pagePath.trim() : ''
  if (p && p !== '/') return p.startsWith('/') ? p : `/${p}`
  return null
}

/** Pure input-bound checks — exported for unit tests. */
export function inputBoundErrors(toolName: string, toolInput: Record<string, unknown>): string[] {
  const errors: string[] = []

  if (toolName.endsWith('_update_blog_meta') || toolName === 'webflow_update_page_meta') {
    const t = typeof toolInput.newTitle === 'string' ? toolInput.newTitle.trim() : ''
    const d = typeof toolInput.newDescription === 'string' ? toolInput.newDescription.trim() : ''
    if (t && (t.length < TITLE_MIN || t.length > TITLE_MAX)) {
      errors.push(
        `EDIT_GATE_FAILED: newTitle is ${t.length} chars; target ${TITLE_MIN}-${TITLE_MAX}. Too short wastes the SERP line, too long gets truncated. Rewrite it inside the range.`,
      )
    }
    if (d && (d.length < DESC_MIN || d.length > DESC_MAX)) {
      errors.push(
        `EDIT_GATE_FAILED: newDescription is ${d.length} chars; target ${DESC_MIN}-${DESC_MAX}. Rewrite it inside the range.`,
      )
    }
  }

  if (toolName.endsWith('_add_internal_link')) {
    const anchor = typeof toolInput.sourceText === 'string' ? toolInput.sourceText.trim().toLowerCase() : ''
    if (anchor && GENERIC_ANCHORS.has(anchor)) {
      errors.push(
        `EDIT_GATE_FAILED: anchor text '${anchor}' is generic. Use a descriptive noun phrase that tells both the reader and Google what the target page is about.`,
      )
    }
  }

  return errors
}

export async function checkEditGates(pool: Pool, input: EditGateInput): Promise<string[]> {
  if (!EDIT_GATE_TOOLS.has(input.toolName)) return []
  const errors: string[] = [...inputBoundErrors(input.toolName, input.toolInput)]
  const path = targetPathOf(input.toolName, input.toolInput, input.cmsPrefix)

  // Duplicate title site-wide.
  const newTitle = (input.toolName.endsWith('_update_blog_meta') || input.toolName === 'webflow_update_page_meta')
    && typeof input.toolInput.newTitle === 'string'
    ? input.toolInput.newTitle.trim() : ''
  if (newTitle) {
    try {
      const { rows } = await pool.query<{ url: string; title: string | null }>(
        `SELECT url, title FROM seo_page_inventory
          WHERE tenant_id = $1 AND http_status BETWEEN 200 AND 299 AND title IS NOT NULL`,
        [input.tenantId],
      )
      for (const row of rows) {
        if (path && pathOf(row.url) === path) continue // own page
        const sim = titleSimilarity(newTitle, row.title ?? '')
        if (sim >= DUP_TITLE_SIMILARITY) {
          errors.push(
            `EDIT_GATE_FAILED: newTitle '${newTitle}' near-duplicates '${row.title}' (${row.url}, ${Math.round(sim * 100)}% similar). Duplicate titles confuse Google about which page to rank. Differentiate it.`,
          )
          break
        }
      }
    } catch (err) {
      logger.info('edit_gate_dup_title_skipped', { tenantId: input.tenantId, err: String(err).slice(0, 160) })
    }
  }

  // Link target must exist (only when we have inventory to check against).
  if (input.toolName.endsWith('_add_internal_link')) {
    const target = typeof input.toolInput.targetUrl === 'string' ? input.toolInput.targetUrl.trim() : ''
    if (target) {
      try {
        const targetPath = target.startsWith('http') ? pathOf(target) : (target.startsWith('/') ? target : `/${target}`)
        const { rows } = await pool.query<{ n: string }>(
          `SELECT COUNT(*) AS n FROM seo_page_inventory WHERE tenant_id = $1`,
          [input.tenantId],
        )
        if (Number(rows[0]?.n ?? 0) > 0) {
          const { rows: hit } = await pool.query(
            `SELECT 1 FROM seo_page_inventory
              WHERE tenant_id = $1 AND http_status BETWEEN 200 AND 299
                AND (url LIKE '%' || $2 OR url LIKE '%' || $2 || '/')
              LIMIT 1`,
            [input.tenantId, targetPath],
          )
          if (hit.length === 0) {
            errors.push(
              `EDIT_GATE_FAILED: internal link target '${target}' is not a known live page in the crawl inventory. Linking to a 404 hurts. Verify the slug via framer_list_blog_items and use an existing page.`,
            )
          }
        }
      } catch (err) {
        logger.info('edit_gate_link_target_skipped', { tenantId: input.tenantId, err: String(err).slice(0, 160) })
      }
    }
  }

  // Protect winners: content changes to a page whose clicks are rising.
  if (path && CONTENT_CHANGE_TOOLS.has(input.toolName)) {
    try {
      const { rows } = await pool.query<{ recent: string | null; prior: string | null }>(
        `SELECT SUM(clicks) FILTER (WHERE date >= NOW()::date - 14)                          AS recent,
                SUM(clicks) FILTER (WHERE date >= NOW()::date - 28 AND date < NOW()::date - 14) AS prior
           FROM ranking_history
          WHERE tenant_id = $1
            AND (page_url LIKE '%' || $2 OR page_url LIKE '%' || $2 || '/')`,
        [input.tenantId, path],
      )
      const recent = Number(rows[0]?.recent ?? 0)
      const prior  = Number(rows[0]?.prior ?? 0)
      if (recent >= WINNER_MIN_CLICKS && recent >= prior * WINNER_RISE_RATIO) {
        errors.push(
          `EDIT_GATE_FAILED: ${path} is actively winning (clicks ${prior}→${recent} over the last two 14-day windows). Do not change content on a rising page — the current version is what's working. Revisit in 2+ weeks if growth stalls, or pick a different page.`,
        )
      }
    } catch (err) {
      logger.info('edit_gate_winner_check_skipped', { tenantId: input.tenantId, err: String(err).slice(0, 160) })
    }
  }

  // Churn cap: executed edits on the same page in the last 30 days.
  if (path) {
    try {
      const slug = typeof input.toolInput.slug === 'string' ? input.toolInput.slug.trim().replace(/^\/+|\/+$/g, '') : ''
      const pagePath = typeof input.toolInput.pagePath === 'string' ? input.toolInput.pagePath.trim() : ''
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM approval_requests
          WHERE tenant_id = $1
            AND tool_name = ANY($2)
            AND status = 'approved'
            AND executed_at >= NOW() - ($3 || ' days')::interval
            AND (($4 <> '' AND tool_input->>'slug' = $4)
              OR ($5 <> '' AND tool_input->>'pagePath' = $5))`,
        [input.tenantId, Array.from(EDIT_GATE_TOOLS), String(CHURN_WINDOW_DAYS), slug, pagePath],
      )
      const n = Number(rows[0]?.n ?? 0)
      if (n >= CHURN_CAP) {
        errors.push(
          `EDIT_GATE_FAILED: ${path} has already had ${n} executed edits in the last ${CHURN_WINDOW_DAYS} days (cap ${CHURN_CAP}). Repeated churn on one page reads as instability. Let the previous changes settle and be measured; work on a different page.`,
        )
      }
    } catch (err) {
      logger.info('edit_gate_churn_skipped', { tenantId: input.tenantId, err: String(err).slice(0, 160) })
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
