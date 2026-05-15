// src/core/slack/blocks/ad-hoc-tight.ts
//
// Renders the tight ad-hoc response — used for Slack-mention runs that
// produce a single output. No TL;DR/broken/working/leverage scaffolding —
// just title, summary, why, optional context notes, and footer. The
// approval card (in the same thread) carries the meaningful next action.
//
// Compare to ad-hoc-check.ts (full structured report) — both render INLINE
// in the anchor message when phase transitions to 'complete'.

import type { KnownBlock } from '@slack/web-api'
import {
  header, section, divider, context, fallbackText, capBlocks, compact,
} from './shared'
import type { AdHocTightReport, RenderedMessage } from './types'

export interface AdHocTightRenderContext {
  elapsedLabel?: string
  specialistCount?: number
}

export function renderAdHocTight(
  report: AdHocTightReport,
  ctx: AdHocTightRenderContext = {},
): RenderedMessage {
  const headerLine = `${report.tenantName} · ${report.title}`
  const notes = report.notes ?? []

  const blocks = compact<KnownBlock>([
    header(`✅ ${headerLine}`),
    divider(),
    section(`${report.summary}\n\n_Why:_ ${report.why}`),
    notes.length > 0 && divider(),
    notes.length > 0 && section(notes.map(n => `•  ${n}`).join('\n')),
    divider(),
    context([
      `Run \`${report.runId.slice(0, 8)}\``,
      ctx.specialistCount != null
        ? `${ctx.specialistCount} specialist${ctx.specialistCount === 1 ? '' : 's'}`
        : null,
      ctx.elapsedLabel ?? null,
    ].filter(Boolean) as string[]),
  ])

  return {
    text: fallbackText({
      title:   headerLine,
      summary: report.summary,
    }),
    blocks: capBlocks(blocks),
  }
}
