import Anthropic    from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import path           from 'path'
import { config }     from '../config'
import { AgentTask }  from '../types'
import { TenantConfig } from '../tenants/types'
import { AGENT_TOOLS, executeTool } from './tools'
import { preToolUseHook } from '../hooks'
import { buildTenantSkillsPrompt } from '../skills/loader'
import { getContextSummary, readProgress } from './progress'
import { retrieveRelevant } from '../memory/vector'
import { startTrace, endTrace, recordUsage } from '../observability/langfuse'
import { createRunRecord, completeRunRecord } from '../memory/postgres'
import { logger } from '../logger'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export interface RunnerResult {
  sessionId:     string
  completed:     boolean
  summary:       string
  tokenCount:    number
  toolCallCount: number
}

export async function runOngoingAgent(task: AgentTask, tenant: TenantConfig): Promise<RunnerResult> {
  const sessionId = uuid()
  const runId     = uuid()
  const workDir   = path.resolve(config.PROGRESS_DIR, task.id)

  logger.info('agent_session_start', { tenantId: task.tenantId, taskId: task.id, sessionId })
  await createRunRecord({ id: runId, tenantId: task.tenantId, taskId: task.id, agentType: task.agentType, sessionId })
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: task.agentType, billingTag: tenant.billingTag, userId: task.slackUserId })

  const hookCtx = { taskId: task.id, sessionId, agentType: task.agentType, tenant, channelId: task.slackChannelId }

  // Pull relevant past learnings from semantic memory
  const learnings = await retrieveRelevant({ tenantId: task.tenantId, agentType: task.agentType, query: task.prompt, topK: 3 })
  const contextSummary = getContextSummary(task.id)
  const system   = buildSystem(task, tenant, learnings)
  const userMsg  = buildSessionPrompt(task, contextSummary)

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  let tokenCount = 0, toolCount = 0, finalOutput = ''

  try {
    let turns = 0
    while (turns < config.AGENT_MAX_TURNS) {
      turns++

      const response = await anthropic.messages.create({
        model:      tenant.agentModel,
        max_tokens: 8096,
        system,
        tools:      AGENT_TOOLS,
        messages,
      })

      tokenCount += (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)

      if (response.stop_reason === 'end_turn') {
        finalOutput = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as Anthropic.TextBlock).text)
          .join('')
        break
      }

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        const results: Anthropic.ToolResultBlockParam[] = []

        for (const tb of toolBlocks) {
          toolCount++
          const event = { toolName: tb.name, toolInput: tb.input as Record<string,unknown>, toolUseId: tb.id, sessionId, taskId: task.id, tenantId: task.tenantId }
          const decision = await preToolUseHook(event, hookCtx)

          if (!decision.approved) {
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: `Tool denied: ${decision.reason}` })
            continue
          }

          const output = await executeTool(tb.name, tb.input as Record<string,unknown>, workDir)
          results.push({ type: 'tool_result', tool_use_id: tb.id, content: output })
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: results })
      }
    }

    recordUsage(sessionId, tenant.agentModel, tokenCount, 0)

    // Parse SESSION_COMPLETE marker from output
    const marker  = finalOutput.match(/SESSION_COMPLETE:\s*(.+?)(?:\s*\|\s*NEXT:\s*(.+))?$/m)
    const summary = marker?.[1]?.trim() ?? finalOutput.slice(-200)
    const next    = marker?.[2]?.trim() ?? 'Continue with next failing feature'

    // Check if all features now pass
    const progress = readProgress(task.id)
    const allDone  = progress?.features.every(f => f.passes) ?? false

    await completeRunRecord({ id: runId, status: 'completed', tokenCount, toolCallCount: toolCount, summary })
    await endTrace(sessionId, 'success', summary)

    logger.info('agent_session_complete', { tenantId: task.tenantId, taskId: task.id, sessionId, allDone, tokenCount })

    return { sessionId, completed: allDone, summary, tokenCount, toolCallCount: toolCount }
  } catch (err) {
    logger.error('agent_session_failed', { tenantId: task.tenantId, taskId: task.id, err: String(err) })
    await completeRunRecord({ id: runId, status: 'failed', tokenCount, toolCallCount: toolCount, error: String(err) })
    await endTrace(sessionId, 'error')
    throw err
  }
}

function buildSystem(task: AgentTask, tenant: TenantConfig, learnings: Array<{ content: string }>): string {
  const learningsSection = learnings.length
    ? `## Relevant past learnings\n${learnings.map(l => `- ${l.content}`).join('\n')}\n`
    : ''

  return `You are ${tenant.clientName}'s ${task.agentType} agent, built by Causal Growth Science.

You work in discrete sessions. Each session you complete ONE failing feature, verify it properly, commit, then stop cleanly. The next session will continue from where you left off.

Rules:
- ONE feature per session. Never attempt multiple at once.
- ALWAYS verify your work end-to-end before marking a feature as passing.
- Update progress.json and features.json after every change.
- Leave the environment in a clean, committed state.
- End every session with: SESSION_COMPLETE: <summary> | NEXT: <next priority>

${learningsSection}
${buildTenantSkillsPrompt(tenant.skills)}`
}

function buildSessionPrompt(task: AgentTask, contextSummary: string): string {
  return `${contextSummary}

Task: ${task.prompt}

Session instructions:

1. ORIENT — Read progress.json and features.json to understand current state.
   Run init.sh to confirm the environment is working.

2. PICK — Identify the single highest-priority failing feature.
   ONE feature only.

3. ACT — Implement or complete the feature.
   Make incremental changes. Commit working checkpoints.

4. VERIFY — Test end-to-end as a real user would.
   Only mark passes:true after genuine verification — not just code review.
   Update features.json.

5. COMMIT — git commit with a descriptive message.
   Update progress.json with recentSummary and nextPriority.

6. STOP — End the session. Output:
   SESSION_COMPLETE: <what you did> | NEXT: <what next session should start with>`
}
