// src/core/slack/index.ts
//
// The Slack presenter manages the run's lifecycle messages in the operator's
// Slack channel. It tracks a mapping of taskId → (tenantId, channelId) so
// that callers (orchestrator, subagent, aggregator) only need to pass the
// taskId without repeating tenant/channel context everywhere.
//
// Usage pattern:
//   1. queue/worker.ts calls presenter.initRun(task) before dispatching
//      the job to orchestrator, subagent, or aggregator.
//   2. Each stage calls lifecycle methods (recordSpecialistQueued, etc.)
//      which look up the tenant/channel from the registered task.
//   3. On completion, completeRun posts the final report.
//
// For Task 0 the messages are plain-text. Block Kit rendering of the
// final report lands in a later PR (parallel work in flight).

import { postToSlack, postBlocksToSlack } from '../../tenants/slackManager'
import { logger } from '../../logger'
import type { AgentTask } from '../../types'
import type { FinalReport } from './blocks/types'

// ── Run registry ──────────────────────────────────────────────────────────

interface RunInfo {
  tenantId:  string
  channelId: string
}

const registry = new Map<string, RunInfo>()

function get(taskId: string): RunInfo | undefined {
  const info = registry.get(taskId)
  if (!info) {
    logger.warn('presenter_run_not_registered', { taskId })
  }
  return info
}

// ── Presenter object ──────────────────────────────────────────────────────

export const presenter = {
  /** Must be called by the queue worker before dispatching any job. */
  initRun(task: AgentTask): void {
    registry.set(task.id, {
      tenantId:  task.tenantId,
      channelId: task.slackChannelId,
    })
  },

  /** Called by orchestrator when a specialist is added to the plan. */
  async recordSpecialistQueued(
    taskId:         string,
    specialistType: string,
    specialistName: string,
    task:           string,
  ): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.info('presenter_specialist_queued', { taskId, specialistType })
    await postToSlack(
      info.tenantId,
      info.channelId,
      `📋 Queuing *${specialistName}*: ${task.slice(0, 120)}`,
    )
  },

  /** Called by orchestrator when it calls complete_planning. */
  async recordPlanComplete(taskId: string, planSummary: string): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.info('presenter_plan_complete', { taskId })
    await postToSlack(
      info.tenantId,
      info.channelId,
      `🗺 *Plan:* ${planSummary}`,
    )
  },

  /** Called by subagent at the top of runSubagent (before the model loop). */
  async recordSpecialistStart(taskId: string, specialistType: string): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.info('presenter_specialist_start', { taskId, specialistType })
    // No Slack message — this fires too often in parallel runs and would
    // flood the channel. The queue message is sufficient.
  },

  /** Called by subagent on successful completion. */
  async recordSpecialistComplete(
    taskId:         string,
    specialistType: string,
    summary:        string,
    tokenCount:     number,
  ): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.info('presenter_specialist_complete', { taskId, specialistType, tokenCount })
    await postToSlack(
      info.tenantId,
      info.channelId,
      `✅ *${specialistType}* done — ${summary.slice(0, 200)}`,
    )
  },

  /** Called by subagent on error. */
  async recordSpecialistFailure(
    taskId:         string,
    specialistType: string,
    error:          string,
  ): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.warn('presenter_specialist_failure', { taskId, specialistType })
    await postToSlack(
      info.tenantId,
      info.channelId,
      `⚠️ *${specialistType}* failed: ${error.slice(0, 200)}`,
    )
  },

  /** Called by aggregator while the LLM synthesis call is in flight. */
  async setPhase(taskId: string, phase: string): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.info('presenter_phase', { taskId, phase })
    if (phase === 'synthesising') {
      await postToSlack(
        info.tenantId,
        info.channelId,
        `🔄 All specialists complete — synthesising final report…`,
      )
    }
  },

  /**
   * Called by aggregator with the final report.
   * Accepts either a structured FinalReport (for Block Kit rendering)
   * or a raw string (graceful degradation path).
   */
  async completeRun(taskId: string, report: FinalReport | string): Promise<void> {
    const info = get(taskId)
    if (!info) return

    if (typeof report === 'string') {
      const text = report.length <= 2800
        ? report
        : report.slice(0, 2800) + '\n\n_[Report continues — full version saved to server]_'
      await postToSlack(info.tenantId, info.channelId, `🎉 *Task complete*\n\n${text}`)
      return
    }

    // Structured report — render a readable summary
    const text = buildReportSummaryText(report)
    await postToSlack(info.tenantId, info.channelId, text)
  },

  /** Called by aggregator on unrecoverable failure. */
  async failRun(taskId: string, error: string): Promise<void> {
    const info = get(taskId)
    if (!info) return
    logger.error('presenter_run_failed', { taskId, error: error.slice(0, 200) })
    await postToSlack(
      info.tenantId,
      info.channelId,
      `❌ Task \`${taskId}\` failed: ${error.slice(0, 300)}`,
    )
  },
}

// ── Report summary renderer ───────────────────────────────────────────────

function buildReportSummaryText(report: FinalReport): string {
  const lines: string[] = []

  if (report.kind === 'ad_hoc') {
    lines.push(`🎉 *${report.title}*`)
    if (report.subtitle) lines.push(`_${report.subtitle}_`)
    lines.push('')
    for (const bullet of report.tldr) lines.push(`• ${bullet}`)
    if (report.broken.length) {
      lines.push('')
      lines.push('*Issues found:*')
      for (const b of report.broken.slice(0, 5)) lines.push(`• [${b.priority}] ${b.text}`)
    }
    if (report.leverage.length) {
      lines.push('')
      lines.push('*Top moves:*')
      for (const l of report.leverage.slice(0, 3)) lines.push(`• ${l.title} — ${l.estImpact}`)
    }
  } else if (report.kind === 'daily') {
    lines.push('📊 *Daily update*')
    lines.push('')
    for (const bullet of report.tldr) lines.push(`• ${bullet}`)
    if (report.awaitingApproval.length) {
      lines.push('')
      lines.push(`*Needs your call (${report.awaitingApproval.length}):*`)
      for (const a of report.awaitingApproval.slice(0, 3)) {
        lines.push(`• ${a.title}`)
      }
    }
  } else {
    lines.push('📈 *Weekly report*')
    lines.push('')
    for (const bullet of report.tldr) lines.push(`• ${bullet}`)
    if (report.topPriorities.length) {
      lines.push('')
      lines.push('*Top priorities next week:*')
      for (const p of report.topPriorities) lines.push(`• [${p.rank}] ${p.title}`)
    }
  }

  return lines.join('\n').slice(0, 3000)
}

// Re-export postBlocksToSlack for use by SEO tools that need to send cards
export { postBlocksToSlack }
