// src/skills/daily-digest/build.ts
//
// Pure builders for the daily digest: payload shape, production-URL
// derivation, and markdown rendering. No I/O in this module — everything
// testable with plain data.

export interface DigestAction {
  toolName:        string
  proposedAction:  string | null
  executedAt:      string          // ISO
  outcome:         'success' | 'failed'
  resolvedBy:      string | null
  autonomous:      boolean
  /** Production URL of the changed page, when derivable. */
  url:             string | null
}

export interface DigestArticle {
  title: string | null
  slug:  string
  url:   string
}

export interface DigestDiscard {
  key:   string
  value: string
}

export interface DigestMetricsWindow {
  clicks:      number
  impressions: number
  position:    number | null
}

export interface DigestMover {
  pageUrl:     string
  clicksLast7: number
  clicksPrior7: number
}

export interface DigestPayload {
  tenantId:    string
  digestDate:  string               // YYYY-MM-DD
  actions:     DigestAction[]
  articles:    DigestArticle[]
  discards:    DigestDiscard[]
  pendingHuman: Array<{ toolName: string; proposedAction: string | null }>
  outcomes:    { wins: number; losses: number; neutral: number; samples: string[] }
  metrics:     { last7: DigestMetricsWindow; prior7: DigestMetricsWindow; topMovers: DigestMover[] }
}

/** Tools whose tool_input.slug identifies the changed CMS page. */
const SLUG_TOOLS = new Set([
  'approve_blog_pitch',
  'framer_confirm_publish',
  'framer_create_and_publish_blog_post',
  'framer_update_blog_meta',
  'framer_update_blog_body',
  'framer_add_blog_alt_text',
  'framer_add_internal_link',
])

export function productionUrlFor(
  toolName: string,
  toolInput: Record<string, unknown>,
  targetDomain: string | null | undefined,
  cmsPrefix: string,
): string | null {
  if (!targetDomain) return null
  const base = `https://${targetDomain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
  if (SLUG_TOOLS.has(toolName)) {
    const slug = typeof toolInput.slug === 'string' ? toolInput.slug.trim().replace(/^\/+|\/+$/g, '') : ''
    if (!slug) return null
    const prefix = cmsPrefix.endsWith('/') ? cmsPrefix : `${cmsPrefix}/`
    return `${base}${prefix}${slug}`
  }
  if (toolName === 'framer_update_marketing_page_text') {
    const p = typeof toolInput.pagePath === 'string' ? toolInput.pagePath.trim() : ''
    if (!p) return null
    return `${base}${p.startsWith('/') ? p : `/${p}`}`
  }
  return null
}

function pct(current: number, prior: number): string {
  if (prior === 0) return current > 0 ? 'new' : '0%'
  const delta = Math.round(((current - prior) / prior) * 100)
  return `${delta >= 0 ? '+' : ''}${delta}%`
}

function fmtPos(p: number | null): string {
  return p === null ? '–' : p.toFixed(1)
}

export function buildDigestMarkdown(p: DigestPayload, clientName: string): string {
  const lines: string[] = []
  lines.push(`# Daily digest — ${clientName} — ${p.digestDate}`)
  lines.push('')

  // Metrics first: the number the client cares about.
  const { last7, prior7, topMovers } = p.metrics
  lines.push('## Search performance (last 7 days vs prior 7)')
  lines.push('')
  lines.push(`Clicks ${last7.clicks} (${pct(last7.clicks, prior7.clicks)}) · Impressions ${last7.impressions} (${pct(last7.impressions, prior7.impressions)}) · Avg position ${fmtPos(last7.position)} (prior ${fmtPos(prior7.position)})`)
  if (topMovers.length > 0) {
    lines.push('')
    lines.push('Top movers by clicks:')
    lines.push('')
    for (const m of topMovers) {
      lines.push(`- ${m.pageUrl}: ${m.clicksPrior7}→${m.clicksLast7}`)
    }
  }
  lines.push('')

  if (p.articles.length > 0) {
    lines.push('## Articles published')
    lines.push('')
    for (const a of p.articles) {
      lines.push(`- [${a.title ?? a.slug}](${a.url})`)
    }
    lines.push('')
  }

  lines.push(`## Changes shipped (${p.actions.filter(a => a.outcome === 'success').length})`)
  lines.push('')
  if (p.actions.length === 0) {
    lines.push('None in the last 24 hours.')
  } else {
    for (const a of p.actions) {
      const flag = a.outcome === 'failed' ? ' — FAILED' : ''
      const who  = a.autonomous ? '' : ' (human-approved)'
      const link = a.url ? ` — [view](${a.url})` : ''
      lines.push(`- ${a.proposedAction ?? a.toolName}${who}${flag}${link}`)
    }
  }
  lines.push('')

  if (p.discards.length > 0) {
    lines.push('## Articles discarded by quality gate')
    lines.push('')
    for (const d of p.discards) lines.push(`- ${d.value}`)
    lines.push('')
  }

  if (p.pendingHuman.length > 0) {
    lines.push(`## Waiting on a human (${p.pendingHuman.length})`)
    lines.push('')
    for (const t of p.pendingHuman) lines.push(`- ${t.proposedAction ?? t.toolName}`)
    lines.push('')
  }

  const { wins, losses, neutral, samples } = p.outcomes
  if (wins + losses + neutral > 0) {
    lines.push(`## Measured outcomes recorded today (${wins} win / ${losses} loss / ${neutral} neutral)`)
    lines.push('')
    for (const s of samples) lines.push(`- ${s}`)
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}
