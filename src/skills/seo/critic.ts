// src/skills/seo/critic.ts
//
// Adversarial critic pass for autonomous propose_action filings. In HITL
// mode a human reviews every card; in autonomous mode that judgment has to
// live somewhere, and the Surfer gate only covers article quality — not
// whether an action makes strategic sense. The critic is a second LLM call
// with an adversarial prompt: its ONLY job is to find the reason this
// specific action shouldn't ship. Decision quality concentrates in a few
// hundred tokens of judgment, so this is cheap relative to a bad live edit.
//
// FAIL-OPEN: any API/parse failure ships the action (available:false). The
// critic is a quality filter, not an availability dependency — the
// deterministic gates (validation, cannibalization, edit gates) already ran
// before this point and they are the hard floor.

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../config'
import { logger } from '../../logger'
import { callAnthropic } from '../../lib/anthropic-call'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

const MAX_INPUT_CHARS = 4000

export interface CriticVerdict {
  ship:      boolean
  reason:    string
  /** Did the critic actually run and return a parseable verdict? */
  available: boolean
}

/** Exported for unit tests: lenient JSON verdict extraction. */
export function parseCriticResponse(text: string): { ship: boolean; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown }
    const verdict = typeof obj.verdict === 'string' ? obj.verdict.toLowerCase().trim() : ''
    if (verdict !== 'ship' && verdict !== 'reject') return null
    return {
      ship:   verdict === 'ship',
      reason: typeof obj.reason === 'string' ? obj.reason.slice(0, 400) : '',
    }
  } catch {
    return null
  }
}

export async function criticReview(args: {
  model:          string
  toolName:       string
  toolInput:      Record<string, unknown>
  proposedAction: string
  whyPriority?:   string
  businessBrief?: string
  targetDomain?:  string
}): Promise<CriticVerdict> {
  const sys =
    `You are an adversarial reviewer for an autonomous SEO agent. The action below will ` +
    `execute against ${args.targetDomain ?? 'the client'}'s LIVE site within minutes if you approve it — ` +
    `no human will see it first. Your only job: find the concrete reason it should NOT ship.\n\n` +
    (args.businessBrief ? `Business context (authoritative): ${args.businessBrief}\n\n` : '') +
    `Reject if ANY of these hold:\n` +
    `- Ungrounded: the rationale doesn't cite specific data (a page, a query, a number) — it's a generic best practice dressed up as a finding.\n` +
    `- Off-lane: the topic/change doesn't fit the business context above (wrong audience, wrong commercial lane).\n` +
    `- Risky: keyword stuffing, over-optimized anchor text, factual claims that could be wrong, tone that would embarrass the brand, or a change that could plausibly REDUCE clicks on a functioning page.\n` +
    `- Pointless: no plausible mechanism by which this change improves search performance.\n\n` +
    `Do NOT reject for style nitpicks, minor phrasing, or improvements you'd merely do differently — ` +
    `if it's grounded, safe, and plausibly useful, it ships. When genuinely uncertain, ship.\n\n` +
    `Respond with ONLY this JSON, nothing else:\n` +
    `{"verdict": "ship" | "reject", "reason": "<one concrete sentence>"}`

  const inputJson = JSON.stringify(args.toolInput ?? {})
  const user =
    `Tool: ${args.toolName}\n` +
    `Proposed action: ${args.proposedAction}\n` +
    (args.whyPriority ? `Agent's rationale: ${args.whyPriority.slice(0, 1200)}\n` : '') +
    `Tool input: ${inputJson.length > MAX_INPUT_CHARS ? inputJson.slice(0, MAX_INPUT_CHARS) + '…(truncated)' : inputJson}`

  try {
    const res = await callAnthropic(anthropic, {
      model:      args.model,
      max_tokens: 300,
      system:     sys,
      messages:   [{ role: 'user', content: user }],
    }, { label: 'autonomous-critic' })

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    const parsed = parseCriticResponse(text)
    if (!parsed) {
      logger.warn('critic_unparseable_response', { toolName: args.toolName, sample: text.slice(0, 120) })
      return { ship: true, reason: 'critic response unparseable — failing open', available: false }
    }
    return { ...parsed, available: true }
  } catch (err) {
    logger.warn('critic_call_failed', { toolName: args.toolName, err: String(err).slice(0, 200) })
    return { ship: true, reason: 'critic unavailable — failing open', available: false }
  }
}
