// src/core/slack/render.ts
//
// Pure rendering: RunState → Slack mrkdwn strings. NO I/O of any kind in this
// file — no DB, no Slack API, no logger. Safe to call inside a transaction.
//
// Splitting render from state mutation lets us:
//   1. Unit-test rendering with handcrafted RunState values.
//   2. Reason about visual regressions independently of locking bugs.
//   3. Re-render the same state cheaply (we do it on every Slack edit).

import type {
  RunState, SpecialistEntry, RunPhase,
  ApprovalRequestInput, ApprovalResolvedInput, BudgetWarningInput,
} from './types'

// ────────────────────────────────────────────────────────────────────────────
// Anchor message — edited in place over the lifetime of the run.
// ────────────────────────────────────────────────────────────────────────────

export function renderAnchor(state: RunState): string {
  const lines: string[] = []
  lines.push(`${phaseEmoji(state.phase)} *${escape(state.clientName)} — ${humaniseAgentType(state.agentType)}*`)
  lines.push(`> ${truncateOneLine(state.prompt, 240)}`)
  lines.push('')
  lines.push(`*Status:* ${phaseLabel(state.phase)} ${elapsedSuffix(state)}`)

  // Plan summary, if the orchestrator gave us one
  if (state.planSummary && state.phase !== 'failed') {
    lines.push(`*Plan:* ${truncateOneLine(state.planSummary, 200)}`)
  }

  // Specialists block (omitted when there are none yet)
  const specialists = Object.values(state.specialists)
  if (specialists.length) {
    lines.push('')
    lines.push('*Specialists:*')
    for (const s of specialists) {
      lines.push(`• ${renderSpecialistLine(s)}`)
    }
  }

  // Footer / error
  if (state.phase === 'failed' && state.errorSummary) {
    lines.push('')
    lines.push(`*Error:* ${truncateOneLine(state.errorSummary, 400)}`)
  } else if (state.phase === 'complete') {
    lines.push('')
    lines.push('_Final report posted in thread ↓_')
  } else if (specialists.length) {
    lines.push('')
    lines.push('_Specialist details posted in thread ↓_')
  }

  return lines.join('\n')
}

function renderSpecialistLine(s: SpecialistEntry): string {
  const name = `*${escape(s.name)}*`
  switch (s.state.status) {
    case 'queued':
      return `⏳ ${name} — queued`
    case 'running':
      return `🔄 ${name} — running (${formatDuration(Date.now() - s.state.startedAt)})${s.state.lastNote ? ` · _${truncateOneLine(s.state.lastNote, 100)}_` : ''}`
    case 'complete': {
      const dur = formatDuration(s.state.completedAt - s.state.startedAt)
      return `✅ ${name} — ${truncateOneLine(s.state.summary, 200)} (${dur})`
    }
    case 'failed': {
      const dur = formatDuration(s.state.failedAt - s.state.startedAt)
      return `❌ ${name} — ${truncateOneLine(s.state.error, 200)} (${dur})`
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Thread posts — replies under the anchor for per-specialist detail and the
// final report.
// ────────────────────────────────────────────────────────────────────────────

export function renderSpecialistComplete(s: SpecialistEntry): string {
  if (s.state.status !== 'complete') return ''
  return [
    `✅ *${escape(s.name)}* finished`,
    `_Tokens used: ${s.state.tokenCount.toLocaleString()}_`,
    '',
    truncate(s.state.summary, 2500),
  ].join('\n')
}

export function renderSpecialistFailed(s: SpecialistEntry): string {
  if (s.state.status !== 'failed') return ''
  return [
    `❌ *${escape(s.name)}* failed`,
    '```',
    truncate(s.state.error, 2000),
    '```',
  ].join('\n')
}

/**
 * The final report goes in the thread. If the report is over Slack's safe
 * single-message size we truncate the inline view and note the full length —
 * a future enhancement is to chunk into multiple thread posts or upload as a
 * snippet. For now, truncate-and-note keeps the channel readable.
 */
export function renderFinalReport(report: string, clientName: string): string {
  const safeLimit = 2800  // Slack hard limit is ~3000; leave headroom for header
  const header = `🎉 *${escape(clientName)} — Final report*`
  if (report.length <= safeLimit) {
    return `${header}\n\n${report}`
  }
  return [
    header,
    '',
    report.slice(0, safeLimit),
    '',
    `_[Report truncated — full length ${report.length.toLocaleString()} chars; saved to server]_`,
  ].join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Approval messages — independent of slack_runs. Posted directly to the
// channel (NOT threaded) so the client team sees them without scrolling.
// ────────────────────────────────────────────────────────────────────────────

export function renderApprovalRequest(input: ApprovalRequestInput): string {
  return [
    `⚠️ *Approval needed* — \`${escape(input.toolName)}\``,
    `*Risk:* ${input.riskLevel.toUpperCase()} — ${escape(input.riskReason)}`,
    `*Task:* \`${input.taskId}\``,
    '',
    'Please review the proposed action in your Approvals sheet and set Status to `approved` or `rejected`.',
  ].join('\n')
}

export function renderApprovalResolved(input: ApprovalResolvedInput): string {
  if (input.decision === 'timeout') {
    return `⏱️ Approval for \`${escape(input.toolName)}\` (task \`${input.taskId}\`) timed out and was treated as rejected.`
  }
  if (input.decision === 'approved') {
    return `✅ \`${escape(input.toolName)}\` approved${input.resolvedBy ? ` by ${escape(input.resolvedBy)}` : ''} (task \`${input.taskId}\`).`
  }
  // rejected
  return [
    `🚫 \`${escape(input.toolName)}\` rejected${input.resolvedBy ? ` by ${escape(input.resolvedBy)}` : ''} (task \`${input.taskId}\`).`,
    input.rejectionReason ? `_Reason:_ ${truncateOneLine(input.rejectionReason, 240)}` : '',
  ].filter(Boolean).join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Budget warning — independent of slack_runs.
// ────────────────────────────────────────────────────────────────────────────

export function renderBudgetWarning(input: BudgetWarningInput): string {
  return [
    `⚠️ *Token budget reached for ${escape(input.clientName)}*`,
    `Spent: ${input.spent.toLocaleString()} / Cap: ${input.cap.toLocaleString()}`,
    `Task \`${input.taskId}\` paused. Increase the per-run cap on the tenant or wait until next reset.`,
  ].join('\n')
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function phaseEmoji(phase: RunPhase): string {
  switch (phase) {
    case 'starting':     return '🚀'
    case 'planning':     return '🧠'
    case 'running':      return '🔄'
    case 'synthesising': return '🧵'
    case 'complete':     return '🎉'
    case 'failed':       return '❌'
  }
}

function phaseLabel(phase: RunPhase): string {
  switch (phase) {
    case 'starting':     return 'Starting up'
    case 'planning':     return 'Planning'
    case 'running':      return 'Running specialists'
    case 'synthesising': return 'Synthesising final report'
    case 'complete':     return 'Complete'
    case 'failed':       return 'Failed'
  }
}

function elapsedSuffix(state: RunState): string {
  const elapsed = Date.now() - state.startedAt
  const tag = state.phase === 'complete' || state.phase === 'failed' ? 'total' : 'elapsed'
  return `(${formatDuration(elapsed)} ${tag})`
}

function humaniseAgentType(t: string): string {
  return t.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

/** Format a millisecond duration as `2m 15s`, `45s`, `1h 5m`. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** Cap to one line and a max length, with ellipsis if truncated. */
function truncateOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Escape Slack mrkdwn special characters that could break formatting if they
 * appear inside user-supplied text (client names, prompts, etc). Slack doesn't
 * support classic backslash-escaping — instead we use HTML entities for the
 * three characters that can be misinterpreted in mrkdwn.
 */
function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
