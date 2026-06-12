export type RiskLevel    = 'low' | 'medium' | 'high' | 'critical'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'
export type AgentStatus  = 'running' | 'completed' | 'failed' | 'waiting_approval'
export type JobType      = 'orchestrate' | 'subagent' | 'aggregate'

/**
 * R3.1 — what initiated this task run.
 *
 * - `slack-mention`  — @-mention from a user in Slack
 * - `slack-command`  — `/agent run …` slash command
 * - `cron-daily`     — fired by the daily scheduler
 * - `cron-weekly`    — fired by the weekly scheduler
 * - `manual`         — programmatic / test / backfill
 *
 * Read by the aggregator to pick the right system prompt and produce the
 * matching FinalReport shape. Optional for backward compatibility with
 * any in-flight Redis jobs at the time of deploy; absent value is
 * treated as 'slack-mention'.
 */
export type TaskTrigger =
  | 'slack-mention'
  | 'slack-command'
  | 'cron-daily'
  | 'cron-weekly'
  | 'cron-end-of-week'
  | 'manual'

export interface AgentTask {
  id: string
  tenantId: string
  agentType: string
  prompt: string
  slackChannelId: string
  slackUserId: string
  /** R3.1 — what initiated this run. Optional for back-compat. */
  trigger?: TaskTrigger
  metadata?: Record<string, unknown>
  createdAt: Date
}

export interface AgentJob {
  jobType: JobType; task: AgentTask; subTaskId?: string
}

export interface ToolUseEvent {
  toolName: string; toolInput: Record<string, unknown>; toolUseId: string
  sessionId: string; taskId: string; tenantId: string
}

export interface HookDecision { approved: boolean; reason?: string }

export interface RunRecord {
  id: string; tenantId: string; taskId: string; agentType: string; sessionId: string
  startedAt: Date; completedAt?: Date; tokenCount: number; toolCallCount: number
  status: AgentStatus; summary?: string; error?: string
}

export interface EvalTask {
  id: string; description: string; prompt: string; expectedOutcome: string
  verifier: (output: string) => boolean | Promise<boolean>
}

export interface EvalResult {
  taskId: string; passed: boolean; output: string
  toolCallCount: number; tokenCount: number; durationMs: number; error?: string
}
