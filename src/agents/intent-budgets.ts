// src/agents/intent-budgets.ts
//
// Per-task-intent budget caps. The subagent loop reads these to scale
// iteration count, max_tokens-per-Anthropic-call, and per-specialist-run
// token ceiling based on what the specialist is being asked to do.
//
// Rationale:
//   - investigate: short read-only Q&A flows. Tight budgets keep cost down.
//   - propose_changes: medium budget for diagnostic + propose loops.
//   - execute_approved: tight budget; executor mostly does one tool call.
//   - daily_generation: BIG budgets. Daily cron researches across four
//     pillars, drafts Framer content (potentially 1500+ word pages),
//     files approvals, snapshots metrics — all in one specialist run.
//     Without bigger budgets it runs out of iterations halfway and
//     produces snapshot-only output.
//
// Shipped as part of Task 0.5 (13 May 2026).

import type { TaskIntent } from '../memory/subtasks'

/**
 * Maximum tool-use iterations per specialist run, by intent.
 * Wraps the subagent's main `while (turns < cap)` loop.
 */
export const ITERATION_CAPS: Record<TaskIntent, number> = {
  investigate:      15,
  propose_changes:  25,
  execute_approved: 10,
  daily_generation: 32,   // autonomous era: grounding + Surfer guidelines +
                          // draft + 5-7 propose_action calls + gate retries
  weekly_audit:     20,   // bigger window: look across the week's deltas
  weekly_digest:    12,   // simpler: gather + format wins, no deep research
}

/**
 * Wall-clock cap per specialist run, by intent. Replaces the flat 8-minute
 * MAX_SPECIALIST_DURATION_MS that silently strangled every daily generation
 * run from 2 July onward (observed need: 8-15 min; Surfer's SERP scrape
 * alone is ~2 min on cache miss). Generous caps are safe because the
 * iteration cap + token ceiling still bound runaway loops — wall-clock is
 * the backstop, not the governor.
 */
export const WALL_CLOCK_CAPS_MS: Record<TaskIntent, number> = {
  investigate:       8 * 60_000,
  propose_changes:  20 * 60_000,
  execute_approved:  8 * 60_000,
  daily_generation: 40 * 60_000,
  weekly_audit:     30 * 60_000,
  weekly_digest:    10 * 60_000,
}

/**
 * max_tokens passed to anthropic.messages.create per call, by intent.
 * daily_generation and weekly_audit need headroom for long reports.
 */
export const MAX_TOKENS_PER_CALL: Record<TaskIntent, number> = {
  investigate:       4096,
  propose_changes:   8096,
  execute_approved:  4096,
  daily_generation: 16384,
  weekly_audit:     16384,
  weekly_digest:     8096,
}

/**
 * Per-specialist-run token ceiling. Hitting this fails the subtask with
 * a clear error rather than letting it blow into 1.8M-token territory.
 */
export const PER_SUBAGENT_TOKEN_CEILING: Record<TaskIntent, number> = {
  investigate:       200_000,
  propose_changes:   500_000,
  execute_approved:  100_000,
  daily_generation: 1_000_000,
  weekly_audit:     1_000_000,
  weekly_digest:     300_000,
}

// ── Cost-efficiency additions (2026-07-24) ────────────────────────────────

/**
 * Soft-stop threshold. When a run crosses this fraction of EITHER its
 * token budget or its wall-clock cap, the loop injects a one-time wrap-up
 * nudge: finish the current item, file what's ready, checkpoint, stop.
 * Measured before this existed: 75% of completed-run spend was runs that
 * hit a HARD cap mid-flight — full price paid for guillotined work.
 */
export const SOFT_STOP_FRACTION = 0.8

/** max_tokens for the graceful wrap-up / cap-summary synthesis call. */
export const WRAPUP_MAX_TOKENS = 2048

/**
 * Model tiering by intent. Most intents inherit the tenant's model
 * (Sonnet); intents that are formatting/recap work rather than reasoning
 * work run on Haiku (~70% cheaper on input, 3x cheaper on output).
 * The wrap-up synthesis call also uses the cheap tier — it summarises a
 * transcript, it doesn't produce client-facing strategy.
 */
export const CHEAP_MODEL = 'claude-haiku-4-5'

const MODEL_OVERRIDE_BY_INTENT: Partial<Record<TaskIntent, string>> = {
  weekly_digest: CHEAP_MODEL,
}

export function modelForIntent(intent: TaskIntent | undefined, tenantModel: string): string {
  if (intent && MODEL_OVERRIDE_BY_INTENT[intent]) return MODEL_OVERRIDE_BY_INTENT[intent]!
  return tenantModel
}

/**
 * Convenience: resolve all three caps for a given intent, with safe
 * fallback if intent is unrecognised (older subtask rows pre-this-task).
 */
export function budgetsFor(intent: TaskIntent | undefined): {
  iterationCap: number
  maxTokens: number
  tokenCeiling: number
  wallClockMs: number
} {
  const safe: TaskIntent = (intent && intent in ITERATION_CAPS)
    ? intent
    : 'propose_changes'
  return {
    iterationCap: ITERATION_CAPS[safe],
    maxTokens: MAX_TOKENS_PER_CALL[safe],
    tokenCeiling: PER_SUBAGENT_TOKEN_CEILING[safe],
    wallClockMs: WALL_CLOCK_CAPS_MS[safe],
  }
}
