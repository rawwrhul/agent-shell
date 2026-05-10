// src/core/slack/types.ts
//
// Shared types for the Slack presenter. Kept dependency-free so render.ts
// (which is pure) can import them without dragging in pg, slack, etc.

/**
 * The lifecycle phase of an agent run from the user's point of view.
 *
 * Transitions are enforced by the presenter, not by the type system, but the
 * intended order is:
 *
 *   starting → planning → running → synthesising → complete
 *
 * Any phase can transition to `failed` on a fatal error (orchestrator throws,
 * aggregator throws, etc.). `complete` and `failed` are terminal.
 */
export type RunPhase =
  | 'starting'      // anchor posted, orchestrator has not yet decided specialists
  | 'planning'      // orchestrator running, spawning specialists
  | 'running'       // all specialists spawned, work in progress
  | 'synthesising'  // all specialists done, aggregator producing final report
  | 'complete'      // aggregator finished, report posted
  | 'failed'        // terminated abnormally; errorSummary set

/**
 * A specialist's state. Discriminated union — narrow on `status` to access
 * status-specific fields. `durationMs` on terminal states is computed at
 * transition time (running.startedAt → now).
 */
export type SpecialistState =
  | { status: 'queued';   spawnedAt: number }
  | { status: 'running';  startedAt: number; lastNote?: string }
  | { status: 'complete'; startedAt: number; completedAt: number; summary: string; tokenCount: number }
  | { status: 'failed';   startedAt: number; failedAt: number; error: string }

export interface SpecialistEntry {
  type:       string  // stable identifier (e.g. 'technical-auditor')
  name:       string  // human-readable (e.g. 'Technical SEO Auditor')
  scopedTask: string  // the specific task the orchestrator gave this specialist
  state:      SpecialistState
}

/**
 * The full state of a Slack run. Persisted as a single JSONB blob in
 * `slack_runs.state`. Read/mutated under SELECT ... FOR UPDATE so concurrent
 * specialists can't trample each other.
 *
 * `revision` increments on every successful mutation. Callers can use it to
 * detect when their rendered view of state is stale before posting to Slack
 * (see presenter.ts).
 */
export interface RunState {
  taskId:      string
  tenantId:    string
  agentType:   string
  clientName:  string
  prompt:      string
  channelId:   string
  startedAt:   number
  phase:       RunPhase
  revision:    number
  planSummary?: string
  specialists: Record<string, SpecialistEntry>  // keyed by specialist `type`
  finalReport?: {
    summaryText: string         // first ~3000 chars of the report
    fullLength:  number          // total chars in the full report
    threadedTs?: string          // ts of the in-thread "full report" post (if any)
  }
  errorSummary?: string
}

/**
 * Inputs for various presenter methods. Kept here so callers don't have to
 * reach into presenter.ts to type their call sites.
 */
export interface StartRunInput {
  taskId:     string
  tenantId:   string
  agentType:  string
  clientName: string
  prompt:     string
  channelId:  string
}

export interface ApprovalRequestInput {
  tenantId:   string
  channelId:  string
  taskId:     string
  toolName:   string
  riskLevel:  string
  riskReason: string
  approvalId: string
}

export interface ApprovalResolvedInput {
  tenantId:   string
  channelId:  string
  taskId:     string
  toolName:   string
  approvalId: string
  decision:   'approved' | 'rejected' | 'timeout'
  resolvedBy?:        string
  rejectionReason?:   string
}

export interface BudgetWarningInput {
  tenantId:    string
  channelId:   string
  taskId:      string
  clientName:  string
  spent:       number
  cap:         number
}

/**
 * Thrown when a presenter method is called with a taskId that has no
 * `slack_runs` row. Indicates a startRun was missed (programming error)
 * rather than a transient failure — caller should log and skip rather than
 * retry.
 */
export class RunNotFoundError extends Error {
  constructor(public readonly taskId: string) {
    super(`No slack_runs row for taskId=${taskId} — did you call startRun?`)
    this.name = 'RunNotFoundError'
  }
}
