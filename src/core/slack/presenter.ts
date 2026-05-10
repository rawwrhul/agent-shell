// src/core/slack/presenter.ts
//
// SlackPresenter — the single point through which all outbound Slack messaging
// flows. Responsibilities:
//
//   1. ONE anchor message per agent run. Posted at startRun, edited in place
//      as state changes (specialists queued, started, completed, etc).
//   2. Per-specialist detail and the final report go in the anchor's THREAD,
//      so the channel stays uncluttered.
//   3. HITL approvals are NON-threaded — they post directly to the channel so
//      the client team sees them.
//   4. Budget warnings are NON-threaded — same visibility logic.
//   5. Run state is persisted in `slack_runs` so any worker process can update
//      the same anchor (specialists may run on different workers from the one
//      that created the run).
//
// Every method here is best-effort with respect to Slack — the DB is the
// source of truth. If chat.update or chat.postMessage fails (rate limit, bot
// kicked from channel, etc) we log and move on. State stays consistent.

import type { App } from '@slack/bolt'
import type { Pool } from 'pg'
import type { Logger } from 'winston'
import {
  RunState, RunPhase, SpecialistEntry, RunNotFoundError,
  StartRunInput, ApprovalRequestInput, ApprovalResolvedInput, BudgetWarningInput,
} from './types'
import {
  renderAnchor, renderSpecialistComplete, renderSpecialistFailed,
  renderFinalReport, renderApprovalRequest, renderApprovalResolved,
  renderBudgetWarning,
} from './render'
import {
  createRun, getRun, mutateRunState, RunRow,
} from './state-store'

export class SlackPresenter {
  constructor(
    private readonly apps:   Map<string, App>,
    private readonly pool:   Pool,
    private readonly logger: Logger,
  ) {}

  // ──────────────────────────────────────────────────────────────────────
  // Run lifecycle — every method here corresponds to a real-world event the
  // caller needs to surface to the client's Slack channel. Methods are
  // idempotent where it makes sense (e.g. recordSpecialistStart on an
  // already-running specialist is a no-op).
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Post the anchor message and create the slack_runs row. Called by the
   * worker when an `orchestrate` job is about to start.
   *
   * If a run already exists for this taskId (retry after crash), we re-use
   * the existing anchor instead of creating a new one. This keeps the
   * channel clean across retries.
   */
  async startRun(input: StartRunInput): Promise<void> {
    const existing = await getRun(this.pool, input.taskId)
    if (existing) {
      this.logger.info('slack_run_already_exists', { taskId: input.taskId })
      return
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
    }

    const text = renderAnchor(initialState)
    const ts = await this.postAnchor(input.tenantId, input.channelId, text)
    if (!ts) {
      this.logger.error('slack_anchor_post_failed', { taskId: input.taskId })
      return
    }

    await createRun(this.pool, {
      taskId:    input.taskId,
      tenantId:  input.tenantId,
      channelId: input.channelId,
      anchorTs:  ts,
      state:     { ...initialState, revision: 1 },
    })

    this.logger.info('slack_run_started', { taskId: input.taskId, anchorTs: ts })
  }

  /** Orchestrator finished planning — note the plan summary, transition phase. */
  async recordPlanComplete(taskId: string, planSummary: string): Promise<void> {
    await this.mutate(taskId, state => ({
      ...state,
      phase: state.phase === 'failed' ? state.phase : 'planning',
      planSummary,
    }))
  }

  /** Orchestrator just spawned a specialist. Add to the list as `queued`. */
  async recordSpecialistQueued(
    taskId: string, type: string, name: string, scopedTask: string,
  ): Promise<void> {
    await this.mutate(taskId, state => ({
      ...state,
      // Once any specialist is queued we're past 'starting'. Don't overwrite
      // 'failed' though — failures are sticky.
      phase: state.phase === 'failed' ? state.phase : 'planning',
      specialists: {
        ...state.specialists,
        [type]: {
          type, name, scopedTask,
          state: { status: 'queued', spawnedAt: Date.now() },
        },
      },
    }))
  }

  /** Subagent worker just picked up a specialist job. queued → running. */
  async recordSpecialistStart(taskId: string, type: string): Promise<void> {
    await this.mutate(taskId, state => {
      const entry = state.specialists[type]
      if (!entry) {
        // Defensive: a specialist starting that we never queued. Add it
        // anyway in `running` state so we still surface progress.
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
        }
      }
      // Idempotent: if we're already running, do nothing.
      if (entry.state.status === 'running') return state
      return {
        ...state,
        phase: state.phase === 'failed' ? state.phase : 'running',
        specialists: {
          ...state.specialists,
          [type]: { ...entry, state: { status: 'running', startedAt: Date.now() } },
        },
      }
    })
  }

  /** Soft-progress note. Optional — not every specialist will emit these. */
  async recordSpecialistProgress(taskId: string, type: string, note: string): Promise<void> {
    await this.mutate(taskId, state => {
      const entry = state.specialists[type]
      if (!entry || entry.state.status !== 'running') return state
      return {
        ...state,
        specialists: {
          ...state.specialists,
          [type]: { ...entry, state: { ...entry.state, lastNote: note } },
        },
      }
    })
  }

  /** Subagent finished successfully. Updates anchor + posts thread reply. */
  async recordSpecialistComplete(
    taskId: string, type: string, summary: string, tokenCount: number,
  ): Promise<void> {
    const row = await this.mutate(taskId, state => {
      const entry = state.specialists[type]
      if (!entry) {
        this.logger.warn('slack_specialist_complete_unknown', { taskId, type })
        return state
      }
      // Compute startedAt — fall back to spawnedAt or now if state was odd.
      const startedAt =
        entry.state.status === 'running'  ? entry.state.startedAt :
        entry.state.status === 'queued'   ? entry.state.spawnedAt :
        Date.now()
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
      }
    })

    if (!row) return
    const entry = row.state.specialists[type]
    if (entry) {
      await this.postThread(row.tenantId, row.channelId, row.anchorTs,
        renderSpecialistComplete(entry))
    }
  }

  /** Subagent failed. Updates anchor + posts thread reply. */
  async recordSpecialistFailure(
    taskId: string, type: string, error: string,
  ): Promise<void> {
    const row = await this.mutate(taskId, state => {
      const entry = state.specialists[type]
      if (!entry) {
        this.logger.warn('slack_specialist_fail_unknown', { taskId, type })
        return state
      }
      const startedAt =
        entry.state.status === 'running'  ? entry.state.startedAt :
        entry.state.status === 'queued'   ? entry.state.spawnedAt :
        Date.now()
      return {
        ...state,
        specialists: {
          ...state.specialists,
          [type]: {
            ...entry,
            state: { status: 'failed', startedAt, failedAt: Date.now(), error },
          },
        },
      }
    })

    if (!row) return
    const entry = row.state.specialists[type]
    if (entry) {
      await this.postThread(row.tenantId, row.channelId, row.anchorTs,
        renderSpecialistFailed(entry))
    }
  }

  /** Aggregator transitioned phase (e.g. to 'synthesising'). */
  async setPhase(taskId: string, phase: RunPhase): Promise<void> {
    await this.mutate(taskId, state => {
      // Don't move backwards out of failed or complete.
      if (state.phase === 'failed' || state.phase === 'complete') return state
      return { ...state, phase }
    })
  }

  /**
   * Aggregator finished — post the final report in the thread, edit anchor
   * to 'complete'. We pass the FULL report; render handles truncation.
   */
  async completeRun(taskId: string, fullReport: string): Promise<void> {
    const row = await this.mutate(taskId, state => ({
      ...state,
      phase: 'complete' as const,
      finalReport: {
        summaryText: fullReport.slice(0, 200),
        fullLength:  fullReport.length,
      },
    }))
    if (!row) return

    const text = renderFinalReport(fullReport, row.state.clientName)
    await this.postThread(row.tenantId, row.channelId, row.anchorTs, text)
  }

  /** Terminal failure (orchestrator or aggregator threw). */
  async failRun(taskId: string, error: string): Promise<void> {
    await this.mutate(taskId, state => {
      if (state.phase === 'complete') return state  // don't undo a success
      return { ...state, phase: 'failed', errorSummary: error }
    })
  }

  // ──────────────────────────────────────────────────────────────────────
  // Approval messages — independent of slack_runs. Posted directly to the
  // channel so the client team sees them without expanding a thread.
  // ──────────────────────────────────────────────────────────────────────

  async requestApproval(input: ApprovalRequestInput): Promise<void> {
    await this.postChannel(input.tenantId, input.channelId, renderApprovalRequest(input))
    this.logger.info('slack_approval_posted', {
      tenantId: input.tenantId, taskId: input.taskId,
      tool: input.toolName, approvalId: input.approvalId,
    })
  }

  async approvalResolved(input: ApprovalResolvedInput): Promise<void> {
    await this.postChannel(input.tenantId, input.channelId, renderApprovalResolved(input))
    this.logger.info('slack_approval_resolved', {
      tenantId: input.tenantId, taskId: input.taskId,
      tool: input.toolName, decision: input.decision,
    })
  }

  // ──────────────────────────────────────────────────────────────────────
  // Budget warning — independent of slack_runs.
  // ──────────────────────────────────────────────────────────────────────

  async postBudgetWarning(input: BudgetWarningInput): Promise<void> {
    await this.postChannel(input.tenantId, input.channelId, renderBudgetWarning(input))
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Mutate state, then re-render and edit the anchor. Returns the new row
   * or null if the run wasn't found (logged + swallowed — the caller can't
   * usefully recover from a missing slack_runs row mid-flight).
   */
  private async mutate(
    taskId: string,
    fn: (s: RunState) => RunState,
  ): Promise<RunRow | null> {
    let row: RunRow
    try {
      row = await mutateRunState(this.pool, taskId, fn)
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        this.logger.warn('slack_run_not_found', { taskId, hint: 'startRun was not called or row was deleted' })
        return null
      }
      this.logger.error('slack_mutate_failed', { taskId, err: String(err) })
      return null
    }

    const text = renderAnchor(row.state)
    await this.editAnchor(row.tenantId, row.channelId, row.anchorTs, text)
    return row
  }

  private async postAnchor(
    tenantId: string, channelId: string, text: string,
  ): Promise<string | null> {
    const app = this.apps.get(tenantId)
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId })
      return null
    }
    try {
      const res = await app.client.chat.postMessage({
        channel: channelId, text, unfurl_links: false,
      })
      return res.ts ?? null
    } catch (err) {
      this.logger.error('slack_post_anchor_failed', { tenantId, channelId, err: String(err) })
      return null
    }
  }

  private async editAnchor(
    tenantId: string, channelId: string, anchorTs: string, text: string,
  ): Promise<void> {
    const app = this.apps.get(tenantId)
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId })
      return
    }
    try {
      await app.client.chat.update({
        channel: channelId, ts: anchorTs, text,
      })
    } catch (err) {
      // Common cases: rate limit (429), message too old to edit, channel changed.
      // None of these are fatal — state is consistent in DB; we'll re-render on
      // the next mutation and might land that one.
      this.logger.warn('slack_edit_anchor_failed', { tenantId, channelId, anchorTs, err: String(err) })
    }
  }

  private async postThread(
    tenantId: string, channelId: string, anchorTs: string, text: string,
  ): Promise<void> {
    const app = this.apps.get(tenantId)
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId })
      return
    }
    if (!text) return  // render returned empty (e.g. status not in expected variant)
    try {
      await app.client.chat.postMessage({
        channel: channelId, thread_ts: anchorTs, text, unfurl_links: false,
      })
    } catch (err) {
      this.logger.warn('slack_thread_post_failed', { tenantId, channelId, anchorTs, err: String(err) })
    }
  }

  private async postChannel(
    tenantId: string, channelId: string, text: string,
  ): Promise<void> {
    const app = this.apps.get(tenantId)
    if (!app) {
      this.logger.warn('slack_no_bot_for_tenant', { tenantId })
      return
    }
    try {
      await app.client.chat.postMessage({
        channel: channelId, text, unfurl_links: false,
      })
    } catch (err) {
      this.logger.error('slack_channel_post_failed', { tenantId, channelId, err: String(err) })
    }
  }
}
