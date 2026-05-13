// src/memory/tools.ts
// Memory tool definitions and execution for specialist agents.
// Provides record_memory, query_memory, scratchpad_write, scratchpad_read.

import Anthropic from '@anthropic-ai/sdk'
import { storeLearning, retrieveRelevant } from './vector'
import { pool } from './postgres'
import { logger } from '../logger'

// ── Tool definitions ──────────────────────────────────────────────────────

export const MEMORY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'record_memory',
    description: 'Persist a learning, win, loss, constraint, or fact worth remembering across agent runs for this tenant. Use sparingly — only for things that would genuinely change future behaviour.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content:  { type: 'string', description: 'The learning or fact to remember. Be specific.' },
        category: {
          type: 'string',
          enum: ['win', 'loss', 'in_progress', 'constraint', 'preference', 'fact', 'learning'],
          description: 'win=something that worked well, loss=failure to avoid, constraint=hard limit, preference=operator preference, fact=stable fact about the tenant, learning=general insight',
        },
      },
      required: ['content', 'category'],
    },
  },
  {
    name: 'query_memory',
    description: 'Retrieve relevant past memories for this tenant based on a query. Returns up to 5 most relevant results.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What you want to know about from past runs.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'scratchpad_write',
    description: 'Write a note to your in-run scratchpad. Useful for tracking intermediate state, partial conclusions, or plans within this run. Scratchpad is cleared after ~14 days.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key:     { type: 'string', description: 'A short key to identify this note (e.g. "homepage-findings", "step-2-result").' },
        content: { type: 'string', description: 'The note content.' },
      },
      required: ['key', 'content'],
    },
  },
  {
    name: 'scratchpad_read',
    description: 'Read a note from your in-run scratchpad.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'The key of the note to read.' },
      },
      required: ['key'],
    },
  },
]

const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map(t => t.name))

export function isMemoryToolName(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name)
}

// ── Execution ─────────────────────────────────────────────────────────────

interface MemoryToolContext {
  tenantId: string
  runId:    string
}

// In-memory scratchpad for the lifetime of this worker process
const scratchpad = new Map<string, string>()

export async function executeMemoryTool(
  name: string,
  input: Record<string, unknown>,
  ctx: MemoryToolContext,
): Promise<string> {
  try {
    switch (name) {
      case 'record_memory': {
        const content  = String(input.content ?? '')
        const category = String(input.category ?? 'learning')
        await storeLearning({
          tenantId:  ctx.tenantId,
          agentType: 'agent',
          content,
          metadata:  { category, runId: ctx.runId, recordedAt: new Date().toISOString() },
        })
        logger.info('memory_recorded', { tenantId: ctx.tenantId, category })
        return `Memory recorded (category: ${category})`
      }

      case 'query_memory': {
        const query = String(input.query ?? '')
        const results = await retrieveRelevant({
          tenantId:  ctx.tenantId,
          agentType: 'agent',
          query,
          topK: 5,
        })
        if (!results.length) return 'No relevant memories found.'
        return results.map(r => `[${r.metadata?.category ?? 'memory'}] ${r.content}`).join('\n\n')
      }

      case 'scratchpad_write': {
        const key     = String(input.key ?? '')
        const content = String(input.content ?? '')
        const scopedKey = `${ctx.tenantId}:${ctx.runId}:${key}`
        scratchpad.set(scopedKey, content)
        return `Scratchpad written: ${key}`
      }

      case 'scratchpad_read': {
        const key = String(input.key ?? '')
        const scopedKey = `${ctx.tenantId}:${ctx.runId}:${key}`
        const content = scratchpad.get(scopedKey)
        return content ?? `(no scratchpad entry for key: ${key})`
      }

      default:
        return `Unknown memory tool: ${name}`
    }
  } catch (err) {
    logger.error('memory_tool_failed', { name, tenantId: ctx.tenantId, err: String(err).slice(0, 200) })
    return `Memory tool error (${name}): ${String(err).slice(0, 200)}`
  }
}

// Suppress unused import warning — pool is available for future tools
void pool
