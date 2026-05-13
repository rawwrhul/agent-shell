// src/core/slack/blocks/proposal-card.ts
//
// Builds the Slack Block Kit message that appears when a specialist calls
// propose_action. The operator sees this card and taps Approve or Reject.
//
// Design goals:
//   - Answer "what will happen?" before the operator commits. Lead with
//     the proposedAction description (plain language, no jargon).
//   - Answer "why now?" via whyPriority — one sentence of business context.
//   - Signal risk clearly without alarming for routine changes.
//   - Approve / Reject buttons have the approvalId encoded in their value
//     so the action handler can update the DB without a separate lookup.
//
// Visual structure:
//   [Risk badge]  Needs your call
//   ─────────────────────────────
//   <proposedAction>
//   Why now: <whyPriority>
//   ─────────────────────────────
//   Tool: <toolName>  ·  Requested: <time>  ·  Specialist: <type>
//   [✓ Approve]   [✗ Reject]

import type { KnownBlock, Button } from '@slack/bolt'
import type { ApprovalCardData, RiskLevel } from './types'

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Build Block Kit blocks for the "Needs your call" approval card.
 * Pure function — no side effects, safe to call in tests.
 */
export function buildProposalCard(data: ApprovalCardData): KnownBlock[] {
  const riskBadge = riskEmoji(data.riskLevel)
  const timeStr   = formatRelativeTime(data.requestedAt)

  return [
    // Header
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${riskBadge} Needs your call`,
        emoji: true,
      },
    },

    // Proposed action (the what)
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${data.proposedAction}*`,
      },
    },

    // Why now (context)
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Why now:* ${data.whyPriority}`,
      },
    },

    // Metadata context row
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Tool: \`${data.toolName}\`  ·  Requested: ${timeStr}  ·  Specialist: ${data.specialistType}`,
        },
      ],
    },

    { type: 'divider' },

    // Action buttons
    {
      type: 'actions',
      elements: [
        buildButton({
          text:     '✓ Approve',
          actionId: 'approve_action',
          value:    data.approvalId,
          style:    'primary',
        }),
        buildButton({
          text:     '✗ Reject',
          actionId: 'reject_action',
          value:    data.approvalId,
          style:    'danger',
        }),
      ],
    },
  ]
}

/**
 * Build the fallback text shown in notifications and accessibility tools
 * when blocks aren't rendered. Also used as the Slack message summary.
 */
export function buildProposalFallbackText(data: ApprovalCardData): string {
  return `${riskEmoji(data.riskLevel)} Needs your call: ${data.proposedAction}`
}

/**
 * Build the resolved-state card. Replaces the original card after the
 * operator approves or rejects, confirming what happened and who decided.
 */
export function buildResolvedCard(
  data: ApprovalCardData,
  resolution: { status: 'approved' | 'rejected'; resolvedBy: string; resolvedAt: Date },
): KnownBlock[] {
  const icon     = resolution.status === 'approved' ? '✅' : '❌'
  const label    = resolution.status === 'approved' ? 'Approved' : 'Rejected'
  const timeStr  = formatRelativeTime(resolution.resolvedAt)

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${icon} *${label}* — ${data.proposedAction}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${label} by <@${resolution.resolvedBy}> · ${timeStr} · Tool: \`${data.toolName}\``,
        },
      ],
    },
  ]
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildButton(opts: {
  text:     string
  actionId: string
  value:    string
  style:    'primary' | 'danger'
}): Button {
  return {
    type:      'button',
    text:      { type: 'plain_text', text: opts.text, emoji: true },
    action_id: opts.actionId,
    value:     opts.value,
    style:     opts.style,
  }
}

function riskEmoji(level: RiskLevel): string {
  switch (level) {
    case 'critical': return '🔴'
    case 'high':     return '🟠'
    case 'medium':   return '🟡'
    case 'low':      return '🟢'
  }
}

/** Returns a human-readable relative time string for display in the card. */
export function formatRelativeTime(date: Date): string {
  const diffMs  = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1)   return 'just now'
  if (diffMin < 60)  return `${diffMin}m ago`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24)   return `${diffHr}h ago`

  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d ago`
}
