// src/core/slack/blocks/anchor.ts
//
// The anchor message: posted at the start of every run, edited in place as
// the run progresses through phases.
//
// Rollout 3 changes:
//   - AnchorState gains an optional `finalReport: FinalReport` field. When
//     phase === 'complete' AND finalReport is set, renderAnchor delegates
//     to the matching report renderer (ad-hoc / daily / weekly) and returns
//     that as the rendered anchor message.
//   - Legacy path preserved: if finalReport is absent but finalSummary is,
//     the original "white_check_mark + summary string" view still works.
//   - All other phases (starting / planning / running / synthesising /
//     failed) render exactly as before.

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
import type { FinalReport, RenderedMessage } from './types';
import { renderAdHocCheck } from './ad-hoc-check';
import { renderAdHocTight } from './ad-hoc-tight';
import { renderDailyRun } from './daily-run';
import { renderWeeklyAudit } from './weekly-audit';

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

  /**
   * R3: structured final report. When set AND phase === 'complete', the
   * anchor delegates to the matching report renderer instead of the
   * legacy summary path. Coexists with finalSummary for backward compat.
   */
  finalReport?: FinalReport;

  /** Legacy final summary (pre-R3). Used when finalReport is absent. */
  finalSummary?: string;

  errorMessage?: string;
}

export function renderAnchor(state: AnchorState): RenderedMessage {
  // ── R3: Delegate to structured report renderer when complete ──
  if (state.phase === 'complete' && state.finalReport) {
    return renderCompleteWithStructuredReport(state, state.finalReport);
  }

  // ── Default path: in-progress / failed / complete-without-report ──
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

    // Final outcome (legacy / fallback path)
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

// ── R3: Structured report delegation ────────────────────────────────

function renderCompleteWithStructuredReport(
  state: AnchorState,
  report: FinalReport,
): RenderedMessage {
  const elapsedMs = state.updatedAt.getTime() - state.startedAt.getTime();
  const elapsedLabel = msToHuman(elapsedMs);
  const specialistCount = state.specialists.length;

  switch (report.kind) {
    case 'ad_hoc':
      return renderAdHocCheck(report, { elapsedLabel, specialistCount });
    case 'ad_hoc_tight':
      return renderAdHocTight(report, { elapsedLabel, specialistCount });
    case 'daily':
      return renderDailyRun(report);
    case 'weekly':
      return renderWeeklyAudit(report);
  }
}

function msToHuman(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

// ── Existing helpers (unchanged) ────────────────────────────────────

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
