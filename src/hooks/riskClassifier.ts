import { RiskLevel, ToolUseEvent } from '../types'

export interface RiskAssessment {
  level:       RiskLevel
  reason:      string
  autoApprove: boolean
}

// Tools that are always read-only — auto-approved
const LOW_RISK = new Set([
  'read_file', 'list_directory', 'web_search', 'web_fetch',
])

// Write-to-disk tools — auto-approved with audit trail
const MEDIUM_RISK = new Set([
  'write_file', 'create_directory',
])

// Bash patterns that signal destructive or outbound operations
const HIGH_RISK_PATTERNS = [
  /curl\s+.*-X\s+(POST|PUT|PATCH|DELETE)/i,
  /git\s+push/i,
  /npm\s+publish/i,
  /gcloud\s+deploy/i,
  /kubectl\s+apply/i,
  /docker\s+push/i,
  /aws\s+s3/i,
  /gsutil\s+cp/i,
  /psql.*\b(INSERT|UPDATE|DELETE)\b/i,
]

const CRITICAL_PATTERNS = [
  /rm\s+-rf/i,
  /DROP\s+(TABLE|DATABASE)/i,
  /chmod\s+777/i,
  /mkfs/i,
  /shutdown|reboot/i,
]

// Agents register high-risk tool names specific to their domain
const agentHighRisk = new Map<string, Set<string>>()

export function registerHighRiskTool(agentType: string, toolName: string) {
  if (!agentHighRisk.has(agentType)) agentHighRisk.set(agentType, new Set())
  agentHighRisk.get(agentType)!.add(toolName)
}

export function classifyRisk(event: ToolUseEvent, agentType?: string): RiskAssessment {
  const { toolName, toolInput } = event

  if (agentType && agentHighRisk.get(agentType)?.has(toolName)) {
    return { level: 'high', reason: `'${toolName}' marked high-risk for ${agentType}`, autoApprove: false }
  }

  if (LOW_RISK.has(toolName))    return { level: 'low',    reason: 'read-only tool',  autoApprove: true }
  if (MEDIUM_RISK.has(toolName)) return { level: 'medium', reason: 'local file write', autoApprove: true }

  if (toolName === 'run_command') {
    const cmd = String(toolInput.command ?? '')
    for (const p of CRITICAL_PATTERNS) {
      if (p.test(cmd)) return { level: 'critical', reason: `Matches critical pattern: ${p}`, autoApprove: false }
    }
    for (const p of HIGH_RISK_PATTERNS) {
      if (p.test(cmd)) return { level: 'high', reason: `Matches high-risk pattern: ${p}`, autoApprove: false }
    }
    return { level: 'medium', reason: 'bash command (no risk pattern)', autoApprove: true }
  }

  // MCP/external tools: infer from name suffix
  if (/_(delete|publish|deploy|send|post|submit)$/.test(toolName)) {
    return { level: 'high', reason: `Tool name implies destructive/outbound action`, autoApprove: false }
  }

  return { level: 'medium', reason: 'unknown tool — defaulting to medium', autoApprove: true }
}
