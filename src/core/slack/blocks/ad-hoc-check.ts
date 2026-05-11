// src/core/slack/blocks/ad-hoc-check.ts
//
// Renders the ad-hoc check report (e.g. an @-mention run like
// "@cgs check the homepage"). Rendered INLINE in the anchor message
// when phase transitions to 'complete' — not a thread reply.
//
// Shape:
//   1. Header     ("Tarino · Homepage check")
//   2. Subtitle   (context: domain · scope · run length)
//   3. TL;DR      — 3-5 outcome-focused bullets
//   4. What's broken — severity-dotted findings with priority
//   5. What's working — checkmark bullets
//   6. Top leverage moves — priority + detail + impact
//   7. Footer context (runId, elapsed)

import type { KnownBlock } from '@slack/web-api';
import {
  header,
  section,
  divider,
  context,
  fallbackText,
  capBlocks,
  compact,
} from './shared';
import type {
  AdHocCheckReport,
  BrokenItem,
  LeverageMove,
  RenderedMessage,
} from './types';

const SEVERITY_DOT: Record<BrokenItem['severity'], string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

export interface AdHocCheckRenderContext {
  elapsedLabel?: string;        // "4m 32s"
  specialistCount?: number;
}

export function renderAdHocCheck(
  report: AdHocCheckReport,
  ctx: AdHocCheckRenderContext = {},
): RenderedMessage {
  const headerLine = `${report.tenantName} · ${report.title}`;
  const subtitle = report.subtitle ?? buildDefaultSubtitle(ctx);

  const blocks = compact<KnownBlock>([
    header(`🔍 ${headerLine}`),
    subtitle && context([`_${subtitle}_`]),

    // ── TL;DR ──
    divider(),
    section(`*TL;DR*\n${bulletList(report.tldr)}`),

    // ── What's broken ──
    report.broken.length > 0 && divider(),
    report.broken.length > 0 &&
      section(`*What's broken*\n${renderBrokenList(report.broken)}`),

    // ── What's working ──
    report.working.length > 0 && divider(),
    report.working.length > 0 &&
      section(`*What's working*\n${renderWorkingList(report.working)}`),

    // ── Top leverage moves ──
    report.leverage.length > 0 && divider(),
    report.leverage.length > 0 &&
      section(`*Top ${report.leverage.length} leverage move${report.leverage.length === 1 ? '' : 's'}*`),
    ...report.leverage.map(renderLeverageMove),

    // ── Footer ──
    divider(),
    context([
      `Run \`${report.runId.slice(0, 8)}\``,
      ctx.specialistCount != null
        ? `${ctx.specialistCount} specialist${ctx.specialistCount === 1 ? '' : 's'}`
        : null,
      ctx.elapsedLabel ?? null,
    ].filter(Boolean) as string[]),
  ]);

  return {
    text: fallbackText({
      title: headerLine,
      summary: report.tldr[0] ?? 'Run complete',
    }),
    blocks: capBlocks(blocks),
  };
}

// ── helpers ─────────────────────────────────────────────────────────

function bulletList(items: string[]): string {
  return items.map((i) => `•  ${i}`).join('\n');
}

function renderBrokenList(items: BrokenItem[]): string {
  return items
    .map((b) => {
      const dot = SEVERITY_DOT[b.severity];
      const meta = b.meta ?? b.priority;
      const trailer = meta ? `   \`${meta}\`` : '';
      return `${dot}  ${b.text}${trailer}`;
    })
    .join('\n');
}

function renderWorkingList(items: string[]): string {
  return items.map((w) => `🟢  ${w}`).join('\n');
}

function renderLeverageMove(move: LeverageMove): KnownBlock {
  return section(
    `\`${move.priority}\`  *${move.title}*\n` +
      `_${move.detail}_\n` +
      `\`${move.estImpact}\``,
  );
}

function buildDefaultSubtitle(ctx: AdHocCheckRenderContext): string | undefined {
  const parts: string[] = [];
  if (ctx.specialistCount != null)
    parts.push(`${ctx.specialistCount} specialist${ctx.specialistCount === 1 ? '' : 's'}`);
  if (ctx.elapsedLabel) parts.push(ctx.elapsedLabel);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
