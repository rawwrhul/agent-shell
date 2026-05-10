// src/orchestrator/index.ts
// The orchestrator is a lightweight Claude agent that:
//   1. Reads the user's task
//   2. Decides which specialists to deploy (not always all of them)
//   3. Spawns each specialist by calling spawn_subagent
//   4. Each spawn creates a SubTask record and enqueues a BullMQ job
//   5. Exits cleanly — the parallel subagents do the actual work
//
// As of Rollout 2, the orchestrator's system prompt is prefixed with the
// tenant's memory context (wins, losses, in-progress threads, learnings,
// constraints, preferences, facts) so planning decisions compound across
// runs instead of starting from zero each time.

import Anthropic      from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import { config }     from '../config'
import { AgentTask }  from '../types'
import { TenantConfig } from '../tenants/types'
import { getSpecialists } from './registry'
import { createSubTask }  from '../memory/subtasks'
import { enqueueSubagentJob } from '../queue/producer'
import { presenter }      from '../core/slack'
import { buildTenantSkillsPrompt } from '../skills/loader'
import { startTrace, endTrace } from '../observability/langfuse'
import { logger } from '../logger'
import { getMemoryContext, toPromptString } from '../memory/runtime'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export async function runOrchestrator(task: AgentTask, tenant: TenantConfig): Promise<void> {
  const sessionId = uuid()
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: 'orchestrator', billingTag: tenant.billingTag, userId: task.slackUserId })

  logger.info('orchestrator_start', { tenantId: task.tenantId, taskId: task.id })

  const specialists = getSpecialists(tenant.agentType)
  const spawnedIds: string[] = []

  // Pull the tenant's memory context. Best-effort — if it fails (DB hiccup,
  // first run for a fresh tenant) we proceed with an empty memory block.
  let memoryPrompt = ''
  try {
    const ctx = await getMemoryContext({
      tenantId: task.tenantId,
      taskType: 'orchestration',
      tokenBudget: 1500,
    })
    memoryPrompt = toPromptString(ctx)
    logger.info('orchestrator_memory_loaded', {
      tenantId: task.tenantId,
      taskId: task.id,
      estimatedTokens: ctx.estimatedTokens,
      slices: {
        wins: ctx.recentWins.length,
        losses: ctx.recentLosses.length,
        inProgress: ctx.inProgress.length,
        learnings: ctx.learnings.length,
        constraints: ctx.constraints.length,
        preferences: ctx.preferences.length,
        facts: ctx.facts.length,
      },
    })
  } catch (err) {
    logger.warn('orchestrator_memory_load_failed', { taskId: task.id, err: String(err) })
  }

  const orchestratorTools: Anthropic.Tool[] = [
    {
      name: 'spawn_subagent',
      description: 'Spawn a specialist subagent to work on a specific part of the overall task. Each subagent runs in parallel with others.',
      input_schema: {
        type: 'object' as const,
        properties: {
          specialist_type: { type: 'string', description: `One of: ${specialists.map(s => s.type).join(', ')}` },
          specific_task:   { type: 'string', description: 'The specific, scoped task for this specialist. Be precise — do not just repeat the original prompt.' },
          context:         { type: 'string', description: 'Key context this specialist needs: domain, credentials available, specific URLs, competitor names, etc.' },
          priority:        { type: 'number', description: 'Execution priority 1-10 (1=highest). Use to sequence when some specialists should start before others.' },
        },
        required: ['specialist_type', 'specific_task', 'context'],
      },
    },
    {
      name: 'complete_planning',
      description: 'Signal that you have finished spawning all needed specialists. Call this when all spawn_subagent calls are done.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plan_summary: { type: 'string', description: 'One sentence summarising which specialists were spawned and why.' },
        },
        required: ['plan_summary'],
      },
    },
  ]

  const baseSystem = buildOrchestratorSystem(task, tenant, specialists)
  const system = memoryPrompt ? `${memoryPrompt}\n\n${baseSystem}` : baseSystem
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildOrchestratorPrompt(task) }]

  try {
    let turns = 0
    while (turns < 10) {
      turns++
      const response = await anthropic.messages.create({
        model:      tenant.agentModel,
        max_tokens: 4096,
        system,
        tools:      orchestratorTools,
        messages,
      })

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        const results: Anthropic.ToolResultBlockParam[] = []

        for (const tb of toolBlocks) {
          if (tb.name === 'spawn_subagent') {
            const input  = tb.input as { specialist_type: string; specific_task: string; context: string; priority?: number }
            const spec   = specialists.find(s => s.type === input.specialist_type)

            if (!spec) {
              results.push({ type: 'tool_result', tool_use_id: tb.id, content: `Unknown specialist type: ${input.specialist_type}` })
              continue
            }

            const subTaskId = await createSubTask({
              parentTaskId:  task.id,
              tenantId:      task.tenantId,
              specialistType: input.specialist_type,
              specialistName: spec.name,
              task:          input.specific_task,
              context:       input.context,
              skills:        spec.defaultSkills.filter(s => tenant.skills.includes(s) || tenant.skills.length === 0),
              priority:      input.priority ?? 5,
            })

            await enqueueSubagentJob({
              task,
              subTaskId,
              priority: input.priority ?? 5,
            })

            spawnedIds.push(subTaskId)

            await presenter.recordSpecialistQueued(
              task.id,
              input.specialist_type,
              spec.name,
              input.specific_task,
            )

            logger.info('subagent_spawned', { tenantId: task.tenantId, taskId: task.id, specialistType: input.specialist_type, subTaskId })
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: `Spawned ${spec.name} (subTaskId: ${subTaskId})` })
          }

          if (tb.name === 'complete_planning') {
            const input = tb.input as { plan_summary: string }
            logger.info('orchestrator_planning_complete', { taskId: task.id, summary: input.plan_summary, subagents: spawnedIds.length })
            await presenter.recordPlanComplete(task.id, input.plan_summary)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: 'Planning complete.' })
            await endTrace(sessionId, 'success', input.plan_summary)
            return
          }
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: results })
      } else {
        // end_turn without complete_planning — still done
        break
      }
    }

    await endTrace(sessionId, 'success', `Spawned ${spawnedIds.length} subagents`)
  } catch (err) {
    logger.error('orchestrator_failed', { taskId: task.id, err: String(err) })
    await endTrace(sessionId, 'error')
    throw err
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildOrchestratorSystem(task: AgentTask, tenant: TenantConfig, specialists: ReturnType<typeof getSpecialists>): string {
  const specList = specialists.map(s =>
    `**${s.type}** — ${s.description}`
  ).join('\n')

  return `You are the orchestrator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.

Your ONLY job is to analyse the user's request and spawn the right specialist subagents to complete it.

If a <tenant_memory> block was prepended above, read it first — it tells you what's been done before, what's in progress, what's been tried and worked or failed, and what constraints apply. Let that shape WHO you spawn and WHAT scoped task you give them. Don't spawn work that's already in progress; build on prior wins; respect constraints.

## Available specialists
${specList}

## Rules
- Spawn ONLY the specialists actually needed for the request. A targeted request may need just one. A full audit needs all.
- Give each specialist a specific, scoped task — not a copy of the original prompt.
- Include all context the specialist will need: target domain, competitor domains, specific pages, available credentials.
- Call complete_planning when all spawns are done.
- Do NOT attempt to do the work yourself. Your only tools are spawn_subagent and complete_planning.

${buildTenantSkillsPrompt(tenant.skills)}`
}

function buildOrchestratorPrompt(task: AgentTask): string {
  return `Task from ${task.slackUserId}: ${task.prompt}

Task ID: ${task.id}

Analyse this request and spawn the appropriate specialist subagents.
Remember: spawn only what is needed, with specific scoped tasks for each.`
}
