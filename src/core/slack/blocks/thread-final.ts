// src/core/slack/blocks/thread-final.ts
//
// Final synthesised report posted in the anchor thread after the orchestrator
// finishes. Used for ad-hoc runs (the user @mentions the bot with a question
// or task) where the output is a single body of analysis rather than the
// structured daily/weekly report shapes.

import type { KnownBlock } from '@slack/web-api';
import {
  section,
  divider,
  context,
  fallbackText,
  truncate,
  compact,
  capBlocks,
} from './shared';
import type { RenderedMessage } from './types';

export interface FinalReportThreadReply {
  /** A short headline for the report — one line. */
  headline: string;
  /**
   * Body sections. Each renders as a separate Section block, so prefer
   * splitting on natural section breaks rather than passing one giant
   * string. Supports Slack mrkdwn.
   */
  sections: ReportSection[];
  /** Optional artifact links shown at the foot. */
  artifacts?: Array<{ label: string; url: string }>;
  /** Total tokens / specialists / cost — shown in context footer. */
  meta?: {
    totalSpecialists?: number;
    totalTokens?: number;
    elapsedMs?: number;
  };
}

export interface ReportSection {
  /** Optional title rendered as a small caps header line above the body. */
  title?: string;
  /** Body — Slack mrkdwn. */
  body: string;
}

export function renderFinalReportThread(report: FinalReportThreadReply): RenderedMessage {
  const headBlock = section(`*${report.headline}*`);

  // Each report section becomes a section block, optionally divided.
  const sectionBlocks: KnownBlock[] = [];
  for (let i = 0; i < report.sections.length; i++) {
    const s = report.sections[i];
    const text = s.title
      ? `*${s.title.toUpperCase()}*\n${s.body}`
      : s.body;
    sectionBlocks.push(section(truncate(text, 2800)));
    // Light divider between sections, but not after the last one.
    if (i < report.sections.length - 1) sectionBlocks.push(divider());
  }

  const artifactsLine = report.artifacts && report.artifacts.length > 0
    ? report.artifacts.map((a) => `<${a.url}|${a.label}>`).join('  ·  ')
    : undefined;

  const metaParts = buildMetaParts(report.meta);

  const blocks = compact<KnownBlock>([
    headBlock,
    divider(),
    ...sectionBlocks,
    artifactsLine && divider(),
    artifactsLine && context([`*Artifacts:*  ${artifactsLine}`]),
    metaParts.length > 0 && context(metaParts),
  ]);

  return {
    text: fallbackText({ title: report.headline }),
    blocks: capBlocks(blocks),
  };
}

function buildMetaParts(meta: FinalReportThreadReply['meta']): string[] {
  if (!meta) return [];
  const parts: string[] = [];
  if (meta.totalSpecialists !== undefined) {
    parts.push(`${meta.totalSpecialists} specialist${meta.totalSpecialists === 1 ? '' : 's'}`);
  }
  if (meta.totalTokens !== undefined) {
    parts.push(`${formatTokens(meta.totalTokens)} tokens`);
  }
  if (meta.elapsedMs !== undefined) {
    const sec = Math.round(meta.elapsedMs / 1000);
    parts.push(sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`);
  }
  return parts;
}

function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
