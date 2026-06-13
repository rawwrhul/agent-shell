// src/core/slack/presenter.ts
//
// SlackPresenter — the single point through which all outbound Slack messaging
// flows. Responsibilities:
//
//   1. ONE anchor message per agent run. Posted at startRun, edited in place
//      as state changes (specialists queued, started, completed, etc).
//   2. Per-specialist detail goes in the anchor's THREAD, so the channel
//      stays uncluttered.
//   3. R3 CHANGE: the FINAL REPORT now renders INLINE in the anchor
//      message itself (not as a thread reply). When completeRun is called,
//      we set state.phase = 'complete' and state.finalReport = <structured>
//      then the mutate() flow re-renders the anchor — the renderAnchor in
//      blocks/anchor.ts delegates to the matching report renderer
//      (renderAdHocCheck / renderDailyRun / renderWeeklyAudit).
//   4. HITL approvals are NON-threaded — they post directly to the channel.
//   5. Budget warnings are NON-threaded — same visibility logic.
//   6. Run state is persisted in `slack_runs` (single JSONB blob).
//
// All Slack ops are best-effort; DB is source of truth.

import type { App } from '@slack/bolt';
import type { Pool } from 'pg';
import type { Logger } from 'winston';
import {
  RunState, RunPhase, SpecialistEntry, RunNotFoundError,
  StartRunInput, ApprovalRequestInput, ApprovalResolvedInput, BudgetWarningInput,
  ExecutionResultInput,
  PendingNudgeInput,
} from './types';
import { buildPerformancePulse } from '../metrics/pulse';
import {
  renderAnchor, renderSpecialistComplete, renderSpecialistFailed,
  renderApprovalRequest, renderApprovalResolved,
  renderBudgetWarning,
  renderExecutionResult,
  renderPendingNudge,
} from './render';
import {
  createRun, getRun, mutateRunState, RunRow,
} from './state-store';
import type { RenderedMessage } from './blocks';
import type { FinalReport } from './blocks/types';

export class SlackPresenter {
  constructor(
    private readonly apps:   Map<string, App>,
    private readonly pool:   Pool,
    private readonly logger: Logger,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // Run lifecycle
  // ──────────────────────────────────────────────────────────────────────

  async startRun(input: StartRunInput): Promise<void> {
    const existing = await getRun(this.pool, input.taskId);
    if (existing) {
      this.logger.info('slack_run_already_exists', { taskId: input.taskId });
      return;
    }

    const initialState: RunState = {
      taskId:      input.taskId,
      tenantId:    input.tenantId,
      agentType:   input.agentType,
      clientName:  input.clientName,
      prompt:      input.prompt,
      channelId:   input.channelId,
      startedAt:   Date.now(),
      phase:       'starting',
      revision:    0,
      specialists: {},
    };

    const message = renderAnchor(initialState);
    const ts = await this.postAnchor(input.tenantId, input.channelId, message);
    if (!ts) {
      this.logger.error('slack_anchor_post_failed', { taskId: input.taskId });
      return;
    }

    await createRun(this.pool, {
      taskId:    input.taskId,
      tenantId:  input.tenantId,
      channelId: input.channelId,
      anchorTs:  ts,
      state:     { ...initialState, revision: 1 },
    });

    this.logger.info('slack_run_started', { taskId: input.taskId, anchorTs: ts });
  }

  async recordPlanComplete(taskId: string, planSummary: string): Promise<void> {
    await this.mutate(taskId, state => ({
      ...state,
      phase: state.phase === 'failed' ? state.phase : 'planning',
      planSummary,
    }));
  }

  async recordSpecialistQueued(
    taskId: string, type: string, name: string, scopedTask: string,
  ): Promise<void> {
    await this.mutate(taskId, state => ({
      ...state,
      phase: state.phase === 'failed' ? state.phase : 'planning',
      specialists: {
        ...state.specialists,
        [type]: {
          type, name, scopedTask,
          state: { status: 'queued', spawnedAt: Date.now() },
        },
      },
    }));
  }

  async recordSpecialistStart(taskId: string, type: string): Promise<void> {
    await this.mutate(taskId, state => {
      const entry = state.specialists[type];
      if (!entry) {
        return {
          ...state,
          phase: state.phase === 'failed' ? state.phase : 'running',
          specialists: {
            ...state.specialists,
            [type]: {
              type, name: type, scopedTask: '',
              state: { status: 'running', startedAt: Date.now() },
            },
          },
        };
      }
      if (entry.state.status === 'running') return state;
      return {
        ...state,
        phase: state.phase === 'failed' ? state.phase : 'running',
        specialists: {
          ...state.specialists,
          [type]: { ...entry, state: { status: 'running', startedAt: Date.now() } },
        },
      };
    });
  }

  async recordSpecialistProgress(taskId: string, type: string, note: string): Promise<void> {
    await this.mutate(taskId, state => {
      const entry = state.specialists[type];
      if (!entry || entry.state.status !== 'running') return state;
      return {
        ...state,
        specialists: {
          ...state.specialists,
          [type]: { ...entry, state: { ...entry.state, lastNote: note } },
        },
      };
    });
  }

  async recordSpecialistComplete(
    taskId: string, type: string, summary: string, tokenCount: number,
  ): Promise<void> {
    const row = await this.mutate(taskId, state => {
      const entry = state.specialists[type];
      if (!entry) {
        this.logger.warn('slack_specialist_complete_unknown', { taskId, type });
        return state;
      }
      const startedAt =
        entry.state.status === 'running'  ? entry.state.startedAt :
        entry.state.status === 'queued'   ? entry.state.spawnedAt :
        Date.now();
      return {
        ...state,
        specialists: {
          ...state.specialists,
          [type]: {
            ...entry,
            state: {
              status: 'complete', startedAt,
              completedAt: Date.now(), summary, tokenCount,
            },
          },
        },
      };
    });

    if (!row) return;
    // Phase 8.5: specialist completion thread post suppressed.
    // The state mutation above already updates the anchor message's
    // summary, so the operator sees the completion in the anchor's
    // TL;DR. The thread-level Task Executor reply was duplicative
    // technical noise — Approve/Reject cards belong in the thread,
    // not bot status echoes.
    void renderSpecialistComplete;  // silence unused-import lint
  }

  async recordSpecialistFailure(
    taskId: string, type: string, error: string,
  ): Promise<void> {
    const row = await this.mutate(taskId, state => {
      const entry = state.specialists[type];
      if (!entry) {
        this.logger.warn('slack_specialist_fail_unknown', { taskId, type });
        return state;
      }
      const startedAt =
        entry.state.status === 'running'  ? entry.state.startedAt :
        entry.state.status === 'queued'   ? entry.state.spawnedAt :
        Date.now();
      return {
        ...state,
        specialists: {
          ...state.specialists,
          [type]: {
            ...entry,
            state: { status: 'failed', startedAt, failedAt: Date.now(), error },
          },
        },
      };
    });

    if (!row) return;
    const entry = row.state.specialists[type];
    if (entry) {
      await this.postThread(row.tenantId, row.channelId, row.anchorTs,
        renderSpecialistFailed(entry));
    }
  }

  async setPhase(taskId: string, phase: RunPhase): Promise<void> {
    await this.mutate(taskId, state => {
      if (state.phase === 'failed' || state.phase === 'complete') return state;
      return { ...state, phase };
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // completeRun — R3: accepts structured FinalReport OR legacy markdown string
  //
  // - Structured: stored in state.finalReport; anchor delegates to the
  //   matching report renderer; renders INLINE in the anchor.
  // - String (legacy): stored as { summaryText, fullLength }; anchor renders
  //   it via the existing summary path. NO thread post (R3 dropped that).
  //
  // If you want the structured shape, pass a FinalReport (kind: 'ad_hoc' |
  // 'daily' | 'weekly'). If you have free-form markdown from the legacy
  // aggregator, pass a string — it'll render as the legacy summary until
  // the aggregator is updated to emit structured JSON.
  // ──────────────────────────────────────────────────────────────────────

  async completeRun(taskId: string, report: FinalReport | string): Promise<void> {
    // Stamp the deterministic performance pulse onto daily reports. SQL
    // numbers on client-facing sends — never LLM-produced. Best-effort:
    // no history (new tenant, gsc disabled) → no pulse line.
    if (typeof report !== 'string' && report.kind === 'daily' && !report.performancePulse) {
      const run = await getRun(this.pool, taskId);
      if (run) {
        const pulse = await buildPerformancePulse(this.pool, run.tenantId).catch(() => null);
        if (pulse) report.performancePulse = pulse;
      }
    }

    await this.mutate(taskId, state => {
      const finalReport: RunState['finalReport'] =
        typeof report === 'string'
          ? { summaryText: report.slice(0, 200), fullLength: report.length }
          : { ...report, renderedInAnchor: true as const };

      return {
        ...state,
        phase: 'complete' as const,
        finalReport,
      };
    });
    // No more postThread call here. mutate() already re-renders the anchor
    // through editAnchor, and the anchor renderer delegates to the matching
    // structured report renderer when state.finalReport.renderedInAnchor is true.
  }

  async failRun(taskId: string, error: string): Promise<void> {
    await this.mutate(taskId, state => {
      if (state.phase === 'complete') return state;
      return { ...state, phase: 'failed', errorSummary: error };
    });
  }

  /**
   * Remove a resolved approval from the anchor's awaitingApproval[] array
   * and re-render the anchor. Called by the HITL approve/reject handler
   * when the click happened on an in-anchor approval button (rather than
   * a threaded individual approval card).
   *
   * Without this, clicking approve on an anchor-embedded card would
   * overwrite the entire anchor message with the small approval-resolved
   * card content — the R3 inline-batched-approvals UI breaks on every click.
   */
  async removeApprovalFromAnchor(taskId: string, approvalId: string): Promise<void> {
    await this.mutate(taskId, state => {
      if (!state.finalReport) return state;
      const fr = state.finalReport;
      // Only daily/weekly/adhoc reports have awaitingApproval[].
      if (!('awaitingApproval' in fr) || !Array.isArray((fr as any).awaitingApproval)) return state;
      const filtered = (fr as any).awaitingApproval.filter((a: { id: string }) => a.id !== approvalId);
      // No change? skip the re-render.
      if (filtered.length === (fr as any).awaitingApproval.length) return state;
      return {
        ...state,
        finalReport: {
          ...(fr as any),
          awaitingApproval: filtered,
        },
      };
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Approval messages — non-threaded
  // ──────────────────────────────────────────────────────────────────────

  // Phase 8: thread approval cards under the run's anchor message so the
  // channel stays clean. Falls back to channel-level if no run row exists.
  async requestApproval(input: ApprovalRequestInput): Promise<void> {
    const run = await getRun(this.pool, input.taskId);
    if (run?.anchorTs) {
      await this.postThread(input.tenantId, input.channelId, run.anchorTs,
        renderApprovalRequest(input));
    } else {
      await this.postChannel(input.tenantId, input.channelId, renderApprovalRequest(input));
    }
    this.logger.info('slack_approval_posted', {
      tenantId: input.tenantId, taskId: input.taskId,
      tool: input.toolName, approvalId: input.approvalId,
      threaded: !!run?.anchorTs,
    });
  }

  // Phase 8: thread approval-resolved messages too.
  async approvalResolved(input: ApprovalResolvedInput): Promise<void> {
    const run = await getRun(this.pool, input.taskId);
    if (run?.anchorTs) {
      await this.postThread(input.tenantId, input.channelId, run.anchorTs,
        renderApprovalResolved(input));
    } else {
      await this.postChannel(input.tenantId, input.channelId, renderApprovalResolved(input));
    }
    this.logger.info('slack_approval_resolved', {
      tenantId: input.tenantId, taskId: input.taskId,
      tool: input.toolName, decision: input.decision,
      threaded: !!run?.anchorTs,
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Execution result — Task 0.5.1: posted after the executor worker runs
  // ──────────────────────────────────────────────────────────────────────
  //
  // Called by the execution worker after dispatching an approved action.
  // Closes the loop after Approve — operator sees what actually shipped
  // (or what failed). Without this, the experience is: Approve → static
  // "Approved by X" card → silence.
  //
  // Non-threaded so the operator definitely sees it in the channel feed.
  // Best-effort: failures are logged but don't propagate (the underlying
  // execution_jobs row + approval_requests.executed_outcome are
  // authoritative for state — this is just the UX surface).

  // Phase 8: thread execution-result notification too.
  async notifyExecutionResult(input: ExecutionResultInput): Promise<void> {
    try {
      const run = await getRun(this.pool, input.taskId);
      if (run?.anchorTs) {
        await this.postThread(input.tenantId, input.channelId, run.anchorTs,
          renderExecutionResult(input));
      } else {
        await this.postChannel(input.tenantId, input.channelId, renderExecutionResult(input));
      }
      this.logger.info('slack_execution_result_posted', {
        tenantId: input.tenantId, taskId: input.taskId,
        approvalId: input.approvalId, ok: input.ok,
      });
    } catch (err) {
      this.logger.warn('slack_execution_result_post_failed', {
        tenantId: input.tenantId, approvalId: input.approvalId,
        err: String(err).slice(0, 200),
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Pending nudge — Task 0.5.1: daily scanner sends a single reminder per
  // tenant with approvals pending past the threshold.
  // ──────────────────────────────────────────────────────────────────────

  async notifyPendingNudge(input: PendingNudgeInput): Promise<void> {
    try {
      await this.postChannel(input.tenantId, input.channelId, renderPendingNudge(input));
      this.logger.info('slack_pending_nudge_posted', {
        tenantId: input.tenantId, pendingCount: input.pendingCount,
        oldestDaysAgo: input.oldestDaysAgo,
      });
    } catch (err) {
      this.logger.warn('slack_pending_nudge_post_failed', {
        tenantId: input.tenantId, err: String(err).slice(0, 200),
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Budget warning — non-threaded
  // ──────────────────────────────────────────────────────────────────────

  async postBudgetWarning(input: BudgetWarningInput): Promise<void> {
    await this.postChannel(input.tenantId, input.channelId, renderBudgetWarning(input));
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private async mutate(
    taskId: string,
    fn: (s: RunState) => RunState,
  ): Promise<RunRow | null> {
    let row: RunRow;
    try {
      row = await mutateRunState(this.pool, taskId, fn);
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        this.logger.warn('slack_run_not_found', { taskId, hint: 'startRun was not called or row was deleted' });
        return null;
      }
      this.logger.error('slack_mutate_failed', { taskId, err: String(err) });
      return null;
    }

    const message = renderAnchor(row.state);
    await this.editAnchor(row.tenantId, row.channelId, row.anchorTs, message);
    return row;
  }

  private async postAnchor(
    tenantId: string, channelId: string, message: RenderedMessage,
  ): Promise<string | null> {
    const app = this.apps.get(tenantId);
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId });
      return null;
    }
    try {
      const res = await app.client.chat.postMessage({
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
      });
      return res.ts ?? null;
    } catch (err) {
      this.logger.error('slack_post_anchor_failed', { tenantId, channelId, err: String(err) });
      return null;
    }
  }

  private async editAnchor(
    tenantId: string, channelId: string, anchorTs: string, message: RenderedMessage,
  ): Promise<void> {
    const app = this.apps.get(tenantId);
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId });
      return;
    }
    try {
      await app.client.chat.update({
        channel: channelId,
        ts: anchorTs,
        text: message.text,
        blocks: message.blocks,
      });
    } catch (err) {
      this.logger.warn('slack_edit_anchor_failed', { tenantId, channelId, anchorTs, err: String(err) });
    }
  }

  private async postThread(
    tenantId: string, channelId: string, anchorTs: string, message: RenderedMessage,
  ): Promise<void> {
    const app = this.apps.get(tenantId);
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId });
      return;
    }
    if (!message.blocks.length) return;
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        thread_ts: anchorTs,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
      });
    } catch (err) {
      this.logger.warn('slack_thread_post_failed', { tenantId, channelId, anchorTs, err: String(err) });
    }
  }

  private async postChannel(
    tenantId: string, channelId: string, message: RenderedMessage,
  ): Promise<void> {
    const app = this.apps.get(tenantId);
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId });
      return;
    }
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
      });
    } catch (err) {
      this.logger.error('slack_channel_post_failed', { tenantId, channelId, err: String(err) });
    }
  }
}
