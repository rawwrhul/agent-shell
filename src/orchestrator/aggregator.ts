// src/orchestrator/aggregator.ts
// Triggered automatically when all subagents for a task have completed.
// Reads each subagent's output, synthesises it into a final report, posts to Slack
// via the SlackPresenter (which edits the run's anchor in place and posts the
// full report into its thread).

import Anthropic      from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import path           from 'path'
import fs             from 'fs'
import { config }     from '../config'
import { AgentTask }  from '../types'
import { TenantConfig } from '../tenants/types'
import { getSubtasks } from '../memory/subtasks'
import { presenter }   from '../core/slack'
import { startTrace, endTrace } from '../observability/langfuse'
import { logger } from '../logger'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export async function runAggregator(task: AgentTask, tenant: TenantConfig): Promise<void> {
  const sessionId = uuid()
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: 'aggregator', billingTag: tenant.billingTag, userId: task.slackUserId })

  logger.info('aggregator_start', { tenantId: task.tenantId, taskId: task.id })

  try {
    // Load all subagent outputs
    const subtasks = await getSubtasks(task.id)
    const completed = subtasks.filter(s => s.status === 'completed' && s.output)

    if (!completed.length) {
      // Degenerate case: every specialist failed. Surface this clearly via the
      // presenter rather than a separate post — the worker's catch will then
      // also see the throw and call failRun (idempotent, just sets the same
      // state).
      logger.error('aggregator_no_outputs', { taskId: task.id })
      await presenter.failRun(task.id, 'No specialist outputs available — every specialist failed.')
      await endTrace(sessionId, 'error')
      return
    }

    // Also try to load detailed output files from disk
    const outputs = completed.map(s => {
      const outputPath = path.resolve(config.PROGRESS_DIR, task.id, 'subagents', s.specialist_type, 'output.md')
      let fullOutput = s.output ?? ''
      if (fs.existsSync(outputPath)) {
        fullOutput = fs.readFileSync(outputPath, 'utf-8')
      }
      return { specialistType: s.specialist_type, specialistName: s.specialist_name, summary: s.summary ?? '', fullOutput }
    })

    logger.info('aggregator_inputs_loaded', { taskId: task.id, specialists: outputs.map(o => o.specialistType) })

    // Transition phase before the LLM call so the channel reflects
    // "synthesising" while the model is working (10–30s typically).
    await presenter.setPhase(task.id, 'synthesising')

    // Single Claude call to synthesise
    const response = await anthropic.messages.create({
      model:      tenant.agentModel,
      max_tokens: 8096,
      system:     buildAggregatorSystem(tenant),
      messages:   [{ role: 'user', content: buildAggregatorPrompt(task, outputs) }],
    })

    const report = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as Anthropic.TextBlock).text)
      .join('')

    // Save the final report to disk
    const reportPath = path.resolve(config.PROGRESS_DIR, task.id, 'final-report.md')
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, report, 'utf-8')

    // Edit anchor → 'complete' and post the (possibly truncated) report into
    // the anchor's thread. Truncation handling lives inside renderFinalReport.
    await presenter.completeRun(task.id, report)

    const usage = response.usage
    const tokenCount = (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0)

    logger.info('aggregator_complete', { taskId: task.id, reportLength: report.length, tokenCount })
    await endTrace(sessionId, 'success', `Final report generated — ${report.length} chars`)
  } catch (err) {
    logger.error('aggregator_failed', { taskId: task.id, err: String(err) })
    // The worker's catch will also call failRun, but doing it here too means
    // the anchor flips to 'failed' even if the throw is swallowed somewhere
    // upstream. failRun is idempotent.
    await presenter.failRun(task.id, String(err).slice(0, 400))
    await endTrace(sessionId, 'error')
    throw err
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildAggregatorSystem(tenant: TenantConfig): string {
  return `You are a senior ${tenant.agentType} specialist synthesising outputs from multiple specialist agents for ${tenant.clientName}.

Your job is to produce a single, cohesive, actionable report that:
- Integrates all specialist findings without duplication
- Prioritises issues using the impact × effort matrix (P1 Critical → P4 Backlog)
- Presents clear, specific recommendations — not vague advice
- Uses a consistent structure the client can act on
- Is honest about limitations or gaps in the analysis

Write for a non-technical client. Be direct. Cut anything that isn't actionable.`
}

function buildAggregatorPrompt(
  task: AgentTask,
  outputs: Array<{ specialistType: string; specialistName: string; summary: string; fullOutput: string }>
): string {
  const sections = outputs.map(o =>
    `## ${o.specialistName} findings\n\n${o.fullOutput}`
  ).join('\n\n---\n\n')

  return `Original task: ${task.prompt}

The following specialist agents have completed their work. Synthesise their findings into one final report.

${sections}

---

Produce the final integrated report now. Structure it clearly with:
1. Executive summary (3-4 sentences)
2. Priority findings (P1-P4 using impact × effort)
3. Recommended immediate actions
4. Supporting detail by area

Be specific. Use actual data and findings from the specialist outputs above.`
}
