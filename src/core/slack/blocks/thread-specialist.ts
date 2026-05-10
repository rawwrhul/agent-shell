// src/core/slack/blocks/thread-specialist.ts
//
// Posted in the anchor thread when an individual specialist completes.
// Lightweight — just the specialist's summary and any artifacts produced.

import type { KnownBlock } from '@slack/web-api';
import {
  context,
  section,
  divider,
  fallbackText,
  formatTime,
  truncate,
  compact,
  capBlocks,
} from './shared';
import type { RenderedMessage } from './types';

export interface SpecialistThreadReply {
  specialistName: string;       // "SEO Auditor"
  status: 'done' | 'failed';
  summary: string;              // What it found / did
  details?: string;             // Optional longer body (Markdown)
  artifacts?: Array<{ label: string; url: string }>;
  startedAt: Date;
  finishedAt: Date;
  errorMessage?: string;        // when status === 'failed'
}

export function renderSpecialistThread(reply: SpecialistThreadReply): RenderedMessage {
  const icon = reply.status === 'done' ? ':white_check_mark:' : ':x:';
  const headerText = `${icon} *${reply.specialistName}*`;

  const elapsedSec = Math.round(
    (reply.finishedAt.getTime() - reply.startedAt.getTime()) / 1000
  );
  const elapsedStr =
    elapsedSec < 60 ? `${elapsedSec}s` : `${Math.round(elapsedSec / 60)}m`;

  const artifactsLine = reply.artifacts && reply.artifacts.length > 0
    ? reply.artifacts.map((a) => `<${a.url}|${a.label}>`).join('  ·  ')
    : undefined;

  const blocks = compact<KnownBlock>([
    section(`${headerText}\n${truncate(reply.summary, 1500)}`),

    reply.details && section(truncate(reply.details, 2800)),

    reply.status === 'failed' && reply.errorMessage &&
      section(`> :warning: ${truncate(reply.errorMessage, 500)}`),

    artifactsLine && context([`*Artifacts:*  ${artifactsLine}`]),

    context([
      `Finished ${formatTime(reply.finishedAt)}`,
      `Took ${elapsedStr}`,
    ]),
  ]);

  return {
    text: fallbackText({
      title: `${reply.specialistName} ${reply.status === 'done' ? 'complete' : 'failed'}`,
      summary: reply.summary,
    }),
    blocks: capBlocks(blocks),
  };
}
