// src/memory/runtime.ts
// Loads tenant memory context for injection into agent system prompts.
// Reads the most recent relevant agent_learnings rows and structures
// them into a MemoryContext the prompt builder can render.

import { pool } from './postgres'
import { logger } from '../logger'

export interface MemoryContext {
  recentWins:    string[]
  recentLosses:  string[]
  inProgress:    string[]
  learnings:     string[]
  constraints:   string[]
  preferences:   string[]
  facts:         string[]
  estimatedTokens: number
}

interface LearningRow {
  content:  string
  metadata: Record<string, unknown>
}

export async function getMemoryContext(opts: {
  tenantId:    string
  taskType:    string
  tokenBudget: number
}): Promise<MemoryContext> {
  const ctx: MemoryContext = {
    recentWins: [], recentLosses: [], inProgress: [],
    learnings: [], constraints: [], preferences: [], facts: [],
    estimatedTokens: 0,
  }

  try {
    const res = await pool.query<LearningRow>(
      `SELECT content, metadata
       FROM agent_learnings
       WHERE tenant_id=$1
       ORDER BY created_at DESC
       LIMIT 50`,
      [opts.tenantId],
    )

    for (const row of res.rows) {
      const cat = String(row.metadata?.category ?? 'learning')
      const content = row.content.slice(0, 300)
      switch (cat) {
        case 'win':         ctx.recentWins.push(content);   break
        case 'loss':        ctx.recentLosses.push(content); break
        case 'in_progress': ctx.inProgress.push(content);   break
        case 'constraint':  ctx.constraints.push(content);  break
        case 'preference':  ctx.preferences.push(content);  break
        case 'fact':        ctx.facts.push(content);        break
        default:            ctx.learnings.push(content);    break
      }
    }

    ctx.estimatedTokens = Math.ceil(
      [...ctx.recentWins, ...ctx.recentLosses, ...ctx.inProgress,
       ...ctx.learnings, ...ctx.constraints, ...ctx.preferences, ...ctx.facts]
        .join(' ').length / 4,
    )
  } catch (err) {
    logger.warn('memory_context_load_failed', { tenantId: opts.tenantId, err: String(err).slice(0, 200) })
  }

  return ctx
}

export function toPromptString(ctx: MemoryContext): string {
  if (ctx.estimatedTokens === 0) return ''

  const sections: string[] = ['<tenant_memory>']

  if (ctx.recentWins.length)   sections.push(`## Recent wins\n${ctx.recentWins.map(w => `- ${w}`).join('\n')}`)
  if (ctx.recentLosses.length) sections.push(`## Recent losses / failures\n${ctx.recentLosses.map(l => `- ${l}`).join('\n')}`)
  if (ctx.inProgress.length)   sections.push(`## In progress\n${ctx.inProgress.map(i => `- ${i}`).join('\n')}`)
  if (ctx.constraints.length)  sections.push(`## Constraints\n${ctx.constraints.map(c => `- ${c}`).join('\n')}`)
  if (ctx.preferences.length)  sections.push(`## Operator preferences\n${ctx.preferences.map(p => `- ${p}`).join('\n')}`)
  if (ctx.facts.length)        sections.push(`## Known facts\n${ctx.facts.map(f => `- ${f}`).join('\n')}`)
  if (ctx.learnings.length)    sections.push(`## Past learnings\n${ctx.learnings.map(l => `- ${l}`).join('\n')}`)

  sections.push('</tenant_memory>')
  return sections.join('\n\n')
}
