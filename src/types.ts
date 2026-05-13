export type RiskLevel    = 'low' | 'medium' | 'high' | 'critical'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected'
export type AgentStatus  = 'running' | 'completed' | 'failed' | 'waiting_approval'
export type JobType      = 'orchestrate' | 'subagent' | 'aggregate'
export type TaskTrigger  = 'slack-mention' | 'slack-command' | 'cron-daily' | 'cron-weekly' | 'manual'

export interface AgentTask {
  id: string; tenantId: string; agentType: string; prompt: string
  slackChannelId: string; slackUserId: string
  trigger?: TaskTrigger
  metadata?: Record<string, unknown>; createdAt: Date
}

export interface AgentJob {
  jobType: JobType; task: AgentTask; subTaskId?: string
}

export interface FeatureItem {
  id: string; category: string; description: string; steps: string[]
  passes: boolean; completedAt?: string; notes?: string
}

export interface ProgressFile {
  taskId: string; agentType: string; createdAt: string; updatedAt: string
  sessionCount: number; features: FeatureItem[]
  recentSummary: string; nextPriority: string; gitCommits: string[]
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
