import Anthropic    from '@anthropic-ai/sdk'
import { config }   from '../config'
import { EvalTask, EvalResult } from '../types'
import { AGENT_TOOLS } from '../agents/tools'
import { sampleEvalTasks } from './tasks/sample'
import { logger } from '../logger'

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export async function runEvals(tasks: EvalTask[] = sampleEvalTasks) {
  logger.info('eval_start', { tasks: tasks.length })
  const results: EvalResult[] = []

  for (const task of tasks) {
    const result = await runSingle(task)
    results.push(result)
    const icon = result.passed ? '✅' : '❌'
    logger.info(`eval_result ${icon}`, { id: task.id, passed: result.passed, tools: result.toolCallCount, tokens: result.tokenCount, ms: result.durationMs })
  }

  printReport(results, tasks)
}

async function runSingle(task: EvalTask): Promise<EvalResult> {
  const start = Date.now()
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task.prompt }]
  let toolCount = 0, tokenCount = 0, finalOutput = ''

  try {
    while (true) {
      const res = await client.messages.create({
        model:      config.AGENT_MODEL,
        max_tokens: 4096,
        tools:      AGENT_TOOLS,
        messages,
        system:     'You are an expert agent being evaluated. Complete the task as accurately as possible.',
      })

      tokenCount += (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0)

      if (res.stop_reason === 'end_turn') {
        finalOutput = res.content.filter(b => b.type === 'text').map(b => (b as Anthropic.TextBlock).text).join('')
        break
      }

      if (res.stop_reason === 'tool_use') {
        const tbs = res.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        toolCount += tbs.length
        messages.push({ role: 'assistant', content: res.content })
        messages.push({ role: 'user', content: tbs.map(tb => ({ type: 'tool_result' as const, tool_use_id: tb.id, content: `[Eval mock: ${tb.name}(${JSON.stringify(tb.input)})]` })) })
      } else break
    }

    return { taskId: task.id, passed: await task.verifier(finalOutput), output: finalOutput, toolCallCount: toolCount, tokenCount, durationMs: Date.now() - start }
  } catch (err) {
    return { taskId: task.id, passed: false, output: '', toolCallCount: toolCount, tokenCount, durationMs: Date.now() - start, error: String(err) }
  }
}

function printReport(results: EvalResult[], tasks: EvalTask[]) {
  const passed = results.filter(r => r.passed).length
  console.log(`\n${'═'.repeat(50)}\n  EVAL REPORT\n${'═'.repeat(50)}`)
  console.log(`  Pass rate:    ${passed}/${results.length} (${Math.round(passed/results.length*100)}%)`)
  console.log(`  Total tokens: ${results.reduce((s,r)=>s+r.tokenCount,0).toLocaleString()}`)
  console.log(`${'─'.repeat(50)}`)
  for (const r of results) {
    const t = tasks.find(x => x.id === r.taskId)!
    console.log(`  ${r.passed?'✅':'❌'} ${t.description}`)
    if (!r.passed) { console.log(`     Expected: ${t.expectedOutcome}`); console.log(`     Got:      ${r.output.slice(0,120)}`); if (r.error) console.log(`     Error:    ${r.error}`) }
  }
  console.log(`${'═'.repeat(50)}\n`)
}

if (require.main === module) runEvals().catch(console.error)
