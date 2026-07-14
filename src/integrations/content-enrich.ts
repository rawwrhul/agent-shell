// src/integrations/content-enrich.ts
//
// Post-gate article enrichment — CMS-agnostic HTML transforms applied AFTER
// the quality gate passes and BEFORE the CMS draft is created:
//
//   1. Byline block: author + credentials + date, from the tenant_memory
//      preference 'article-author' (value JSON: {"name","title","licence"}).
//      E-E-A-T signal that agent articles were missing entirely.
//   2. In-body images: up to 2 Pexels photos inserted after evenly-spaced
//      H2s that don't already have nearby images, using the photo's own
//      alt text (falls back to the section heading).
//
// Every step fails open: enrichment never blocks a publish.

import { searchPexelsPhotos } from './pexels/client'
import { getMemoryByKey } from '../memory/runtime'
import { logger } from '../logger'
import type { TenantConfig } from '../tenants/types'

// ── pure helpers (exported for tests) ───────────────────────────────────────

export interface H2Slot { index: number; heading: string; insertAt: number }

/** Find H2 sections lacking an <img> within the following 1200 chars; pick
 *  up to `max` slots spaced across the article (skip the first H2 — the
 *  hero image already covers the top). insertAt = char offset just after
 *  the H2's closing tag. */
export function findImageSlots(html: string, max = 2): H2Slot[] {
  const h2s: Array<{ heading: string; end: number }> = []
  const re = /<h2[^>]*>([\s\S]*?)<\/h2>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    h2s.push({ heading: m[1].replace(/<[^>]+>/g, '').trim(), end: m.index + m[0].length })
  }
  if (h2s.length <= 1) return []

  const NAV_HEADINGS = /table of contents|key takeaways|frequently asked|faq|references|sources/i
  const candidates = h2s
    .slice(1) // skip first section
    .filter(h => !NAV_HEADINGS.test(h.heading))
    .filter(h => !/<img\s/i.test(html.slice(h.end, h.end + 1200)))
  if (candidates.length === 0) return []

  const picks: H2Slot[] = []
  const step = Math.max(1, Math.floor(candidates.length / max))
  for (let i = 0; i < candidates.length && picks.length < max; i += step) {
    picks.push({ index: i, heading: candidates[i].heading, insertAt: candidates[i].end })
  }
  return picks
}

/** Simplify a heading into a 2-4 word concrete Pexels query. */
export function imageQueryFor(heading: string, clientContext: string): string {
  const stop = new Set(['the', 'a', 'an', 'your', 'you', 'to', 'of', 'for', 'and', 'or', 'in', 'on', 'with', 'what', 'when', 'why', 'how', 'is', 'are', 'do', 'does', 'need', 'guide', 'complete', 'vs'])
  const words = heading.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w))
  return [...words.slice(0, 3), clientContext].filter(Boolean).join(' ').trim()
}

export function buildBylineHtml(args: {
  name: string; title?: string; licence?: string; dateIso?: string
}): string {
  const date = new Date(args.dateIso ?? Date.now())
  const dateStr = date.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  const parts = [
    `Written by <strong>${args.name}</strong>`,
    args.title ? args.title : '',
    args.licence ? `Licence ${args.licence}` : '',
  ].filter(Boolean).join(' · ')
  return `<p><em>${parts} · Published ${dateStr}</em></p>`
}

export function insertAtOffsets(html: string, inserts: Array<{ at: number; fragment: string }>): string {
  let out = html
  for (const ins of [...inserts].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, ins.at) + ins.fragment + out.slice(ins.at)
  }
  return out
}

// ── main entry ───────────────────────────────────────────────────────────────

export async function enrichArticleHtml(args: {
  tenant:  TenantConfig
  title:   string
  keyword: string
  content: string
}): Promise<string> {
  let html = args.content

  // 1. In-body images (up to 2).
  try {
    const slots = findImageSlots(html, 2)
    const context = (args.tenant.businessBrief ?? '').toLowerCase().includes('electric') ? 'electrician' : 'australia business'
    const inserts: Array<{ at: number; fragment: string }> = []
    for (const slot of slots) {
      const q = imageQueryFor(slot.heading, context)
      if (!q) continue
      const res = await searchPexelsPhotos({ query: q, per_page: 3, orientation: 'landscape' }).catch(() => null)
      const photo = res?.photos?.[0]
      if (!photo) continue
      const src = photo.src?.landscape ?? photo.src?.large
      if (!src) continue
      const alt = (photo.alt && photo.alt.trim()) || slot.heading
      inserts.push({ at: slot.insertAt, fragment: `<figure><img src="${src}" alt="${alt.replace(/"/g, '&quot;')}" loading="lazy"></figure>` })
    }
    if (inserts.length > 0) html = insertAtOffsets(html, inserts)
    logger.info('article_enriched_images', { tenantId: args.tenant.tenantId, inserted: inserts.length })
  } catch (err) {
    logger.warn('article_enrich_images_failed', { tenantId: args.tenant.tenantId, err: String(err).slice(0, 160) })
  }

  // 2. Byline block at top (idempotent — never doubles up).
  try {
    if (html.includes('Written by')) return html
    const mem = await getMemoryByKey(args.tenant.tenantId, 'preference', 'article-author')
    if (mem?.value) {
      const author = JSON.parse(mem.value) as { name?: string; title?: string; licence?: string }
      if (author.name) {
        html = buildBylineHtml({ name: author.name, title: author.title, licence: author.licence }) + html
      }
    }
  } catch (err) {
    logger.warn('article_enrich_byline_failed', { tenantId: args.tenant.tenantId, err: String(err).slice(0, 160) })
  }

  return html
}

// ── reference-field matching (Webflow multi-refs / options) ────────────────

/** Deterministic name→tokens overlap match. Exported for tests. */
export function matchByTokenOverlap(
  targetText: string,
  candidates: Array<{ id: string; name: string }>,
  maxPicks: number,
): string[] {
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'installation', 'services', 'service'])
  const tokens = new Set(
    targetText.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w)),
  )
  const scored = candidates
    .map(c => {
      const cTokens = c.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w))
      const hits = cTokens.filter(t => tokens.has(t)).length
      return { id: c.id, hits, ratio: cTokens.length ? hits / cTokens.length : 0 }
    })
    .filter(s => s.hits > 0)
    .sort((a, b) => b.ratio - a.ratio || b.hits - a.hits)
  return scored.slice(0, maxPicks).map(s => s.id)
}
