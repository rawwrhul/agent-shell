import Anthropic    from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import path           from 'path'
import fs             from 'fs'
import { config }     from '../config'
import { AgentTask }  from '../types'
import { TenantConfig } from '../tenants/types'
import { AGENT_TOOLS, executeTool } from './tools'
import { preToolUseHook } from '../hooks'
import { buildTenantSkillsPrompt } from '../skills/loader'
import { startTrace, endTrace } from '../observability/langfuse'
import { createRunRecord, completeRunRecord } from '../memory/postgres'
import { logger } from '../logger'
import { cachedSystem, cachedTools } from '../lib/prompt-cache'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export async function runInitializerAgent(task: AgentTask, tenant: TenantConfig): Promise<void> {
  const sessionId = uuid()
  const runId     = uuid()
  const workDir   = path.resolve(config.PROGRESS_DIR, task.id)
  fs.mkdirSync(workDir, { recursive: true })

  logger.info('initializer_start', { tenantId: task.tenantId, taskId: task.id, sessionId })
  await createRunRecord({ id: runId, tenantId: task.tenantId, taskId: task.id, agentType: task.agentType, sessionId })
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: task.agentType, billingTag: tenant.billingTag, userId: task.slackUserId })

  const hookCtx = { taskId: task.id, sessionId, agentType: task.agentType, tenant, channelId: task.slackChannelId }
  const system  = buildInitializerSystem(task, tenant)
  const userMsg = buildInitializerPrompt(task, workDir)

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMsg }]
  let tokenCount = 0, toolCount = 0

  try {
    let turns = 0
    while (turns < 20) {
      turns++
      const response = await anthropic.messages.create({
        model:      tenant.agentModel,
        max_tokens: 8096,
        system:     cachedSystem(system),
        tools:      cachedTools(AGENT_TOOLS),
        messages,
      })

      // Phase A: four-field accounting. Sum all input variants, scaling
      // cache_read at 0.10x to reflect Anthropic's billing (cache hits cost
      // 10% of normal input).
      const usage = response.usage
      const inputTokens    = usage?.input_tokens                ?? 0
      const cacheCreation  = usage?.cache_creation_input_tokens ?? 0
      const cacheRead      = usage?.cache_read_input_tokens     ?? 0
      const outputTokens   = usage?.output_tokens               ?? 0
      const billedThisTurn = inputTokens + cacheCreation + Math.round(cacheRead * 0.10) + outputTokens
      tokenCount += billedThisTurn
      logger.info('initializer_tokens', {
        taskId:           task.id,
        turn:             turns,
        input_tokens:     inputTokens,
        cache_creation:   cacheCreation,
        cache_read:       cacheRead,
        output_tokens:    outputTokens,
        billed_this_turn: billedThisTurn,
        cumulative:       tokenCount,
      })

      if (response.stop_reason === 'end_turn') {
        logger.info('initializer_complete', { taskId: task.id, tokenCount, toolCount })
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

    await completeRunRecord({ id: runId, status: 'completed', tokenCount, toolCallCount: toolCount, summary: 'Initializer completed' })
    await endTrace(sessionId, 'success', 'Initializer agent completed')
  } catch (err) {
    logger.error('initializer_failed', { taskId: task.id, err: String(err) })
    await completeRunRecord({ id: runId, status: 'failed', tokenCount, toolCallCount: toolCount, error: String(err) })
    await endTrace(sessionId, 'error')
    throw err
  }
}

function buildInitializerSystem(task: AgentTask, tenant: TenantConfig): string {
  return `You are the initializer agent for ${tenant.clientName}'s ${task.agentType} agent.

Your ONLY job is to set up the working environment for all subsequent sessions.
Work in the directory provided. Be exhaustive. Never declare the task complete.

${buildTenantSkillsPrompt(tenant.skills)}`
}

function buildInitializerPrompt(task: AgentTask, workDir: string): string {
  return `Task: ${task.prompt}
Task ID: ${task.id}
Agent type: ${task.agentType}
Work directory: ${workDir}

Complete these steps in order:

1. ANALYSE the task and create features.json — a comprehensive list of every capability, check, or deliverable needed:
   { "features": [{ "id": "F001", "category": "...", "description": "...", "steps": [...], "passes": false }] }
   Be exhaustive. Mark NOTHING as passing yet.

2. Write init.sh — a script that verifies all required env vars are set and tests connectivity to any external APIs. Make it executable.

3. Write progress.json:
   { "taskId": "${task.id}", "agentType": "${task.agentType}", "sessionCount": 0,
     "recentSummary": "Environment initialised.", "nextPriority": "Run init.sh then start F001." }

4. Run init.sh and fix any failures.

5. Git init + initial commit:
   git init && git add . && git commit -m "init: ${task.agentType} environment for ${task.id}"

When done output exactly:
INITIALIZER_COMPLETE: <one-line summary>`
}
