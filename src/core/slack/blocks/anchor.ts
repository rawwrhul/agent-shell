// src/core/slack/blocks/anchor.ts
//
// The anchor message: posted at the start of every run, edited in place
// as the run progresses through phases. Replaces the mrkdwn anchor render
// from Rollout 1.

import type { KnownBlock } from '@slack/web-api';
import {
  header,
  section,
  context,
  divider,
  itemList,
  fallbackText,
  formatTime,
  phaseIcon,
  compact,
  capBlocks,
  type ListItem,
  type PhaseStatus,
} from './shared';
import type { RenderedMessage } from './types';

export type RunPhase =
  | 'starting'
  | 'planning'
  | 'running'
  | 'synthesising'
  | 'complete'
  | 'failed';

export interface SpecialistState {
  id: string;
  name: string;             // "SEO Auditor"
  status: PhaseStatus;
  startedAt?: Date;
  finishedAt?: Date;
  summary?: string;         // one-line summary once done
}

export interface AnchorState {
  tenantName: string;
  runId: string;
  phase: RunPhase;
  startedAt: Date;
  updatedAt: Date;

  /** The user prompt that triggered the run — shown for context. */
  prompt?: string;

  /** Plan summary, populated once orchestrator decides on specialists. */
  planSummary?: string;

  /** Specialists, in order they were spawned. Empty for single-executor runs. */
  specialists: SpecialistState[];

  /** Approval pending — blocks the run until human input. */
  approvalPending?: {
    summary: string;
    requestedAt: Date;
  };

  /** Final outcome on completion. */
  finalSummary?: string;
  errorMessage?: string;
}

export function renderAnchor(state: AnchorState): RenderedMessage {
  const headerLine = anchorHeaderLine(state);
  const subline = anchorSubline(state);

  const blocks = compact<KnownBlock>([
    header(headerLine),
    state.prompt && context([`_${truncatePrompt(state.prompt)}_`]),
    section(subline),

    // Plan section, only when we have one
    state.planSummary && divider(),
    state.planSummary && section(`*Plan*\n${state.planSummary}`),

    // Specialist progress list
    state.specialists.length > 0 && divider(),
    state.specialists.length > 0 &&
      itemList(state.specialists.map(specialistToListItem)),

    // Approval pending banner
    state.approvalPending && divider(),
    state.approvalPending &&
      section(
        `:hourglass_flowing_sand: *Awaiting your approval*\n${state.approvalPending.summary}\n_Requested ${formatTime(state.approvalPending.requestedAt)}_`
      ),

    // Final outcome
    state.phase === 'complete' && state.finalSummary && divider(),
    state.phase === 'complete' &&
      state.finalSummary &&
      section(`:white_check_mark: ${state.finalSummary}`),

    state.phase === 'failed' && divider(),
    state.phase === 'failed' &&
      section(`:x: *Run failed* — ${state.errorMessage ?? 'see logs for details'}`),

    // Footer
    divider(),
    context(anchorContextParts(state)),
  ]);

  return {
    text: fallbackText({ title: headerLine, summary: subline }),
    blocks: capBlocks(blocks),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

function anchorHeaderLine(state: AnchorState): string {
  const phaseLabel = phaseDisplayName(state.phase);
  return `${state.tenantName} · ${phaseLabel}`;
}

function anchorSubline(state: AnchorState): string {
  switch (state.phase) {
    case 'starting':
      return ':zap: Spinning up the agent…';
    case 'planning':
      return ':brain: Planning approach…';
    case 'running': {
      const done = state.specialists.filter((s) => s.status === 'done').length;
      const total = state.specialists.length;
      if (total === 0) return ':gear: Working…';
      return `:gear: Specialists running — ${done}/${total} complete`;
    }
    case 'synthesising':
      return ':sparkles: Synthesising final report…';
    case 'complete':
      return ':white_check_mark: Run complete';
    case 'failed':
      return ':x: Run failed';
  }
}

function phaseDisplayName(phase: RunPhase): string {
  switch (phase) {
    case 'starting':     return 'Starting';
    case 'planning':     return 'Planning';
    case 'running':      return 'Running';
    case 'synthesising': return 'Synthesising';
    case 'complete':     return 'Complete';
    case 'failed':       return 'Failed';
  }
}

function specialistToListItem(s: SpecialistState): ListItem {
  const meta = specialistMeta(s);
  return {
    icon: phaseIcon(s.status),
    title: s.name,
    detail: s.summary,
    meta,
  };
}

function specialistMeta(s: SpecialistState): string | undefined {
  if (s.status === 'done' && s.finishedAt && s.startedAt) {
    const ms = s.finishedAt.getTime() - s.startedAt.getTime();
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    return `${Math.round(sec / 60)}m`;
  }
  if (s.status === 'in_progress' && s.startedAt) {
    const ms = Date.now() - s.startedAt.getTime();
    return `${Math.round(ms / 1000)}s`;
  }
  if (s.status === 'failed') return 'failed';
  return undefined;
}

function anchorContextParts(state: AnchorState): string[] {
  const elapsed = Math.round((state.updatedAt.getTime() - state.startedAt.getTime()) / 1000);
  const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}m ${elapsed % 60}s`;
  return [
    `Run \`${state.runId.slice(0, 8)}\``,
    `Elapsed: ${elapsedStr}`,
    `Updated ${formatTime(state.updatedAt)}`,
  ];
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= 200) return prompt;
  return prompt.slice(0, 197) + '…';
}
