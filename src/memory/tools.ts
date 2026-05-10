// src/memory/tools.ts
//
// Anthropic tool definitions that let specialists read and write memory
// during a run. Bind MEMORY_TOOLS into the subagent's tool list and route
// calls through executeMemoryTool when isMemoryToolName is true.
//
// All four tools are scoped to one tenant + one run via the
// MemoryToolContext closure — the agent cannot accidentally read or
// write to the wrong tenant's memory.

import type Anthropic from '@anthropic-ai/sdk'
import * as memory from './runtime'
import type { MemoryType } from './types'

export const MEMORY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'record_memory',
    description:
      "Persist a learning, win, loss, decision, constraint, or preference about this tenant. " +
      "Use sparingly — only for facts worth carrying into future runs. " +
      "Re-using the same key updates the existing entry (evidence count goes up, confidence rises).",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['win','loss','in_progress','learning','decision','constraint','preference','fact'],
          description: 'The kind of memory. win/loss = something that worked or failed. in_progress = open thread waiting for next run. learning = observation about the tenant\'s site/audience/market. decision = strategic call worth honouring. constraint = something you cannot do. preference = style/format preference. fact = ground-truth fact.',
        },
        key: {
          type: 'string',
          description: 'Short stable handle in kebab-case (e.g. "homepage-faq-coverage", "voice-no-corporate-fluff"). Re-using a key updates the existing entry.',
        },
        value: {
          type: 'string',
          description: 'The thing to remember, in your own words. Concrete and specific. Will be fed verbatim into future system prompts.',
        },
        confidence: {
          type: 'number',
          description: 'Optional 0..1 confidence, default 0.5. Use higher values (0.8+) when the fact has been directly verified.',
        },
      },
      required: ['type', 'key', 'value'],
    },
  },
  {
    name: 'query_memory',
    description:
      "Read this tenant's prior memories. Without a type filter, returns recent entries across all types. " +
      "Useful when you want to see what's been tried before, what constraints apply, or what's in progress.",
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['win','loss','in_progress','learning','decision','constraint','preference','fact'],
          description: 'Optional. Filter to one memory type.',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return. Default 10.',
        },
      },
      required: [],
    },
  },
  {
    name: 'scratchpad_write',
    description:
      "Save an intermediate observation to this run's scratchpad. Use for tool results, mid-run reasoning, " +
      "or hypotheses you want to refer back to later in the same run. NOT a substitute for record_memory — " +
      "scratchpad is wiped after ~14 days.",
    input_schema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description: 'Free-form key to namespace the entry (e.g. "fetched-pricing-page", "competitor-analysis").',
        },
        value: {
          type: 'string',
          description: 'The content to save. Plain text or JSON-encoded data.',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'scratchpad_read',
    description:
      "Read entries from this run's scratchpad. Without a key, returns everything. With a key, returns " +
      "only entries with that key (in insertion order).",
    input_schema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          description: 'Optional. Filter to entries with this key.',
        },
      },
      required: [],
    },
  },
]

const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name))

export function isMemoryToolName(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name)
}

export interface MemoryToolContext {
  tenantId: string
  runId: string
}

const SCRATCHPAD_OUTPUT_CAP = 3000

export async function executeMemoryTool(
  name: string,
  input: Record<string, unknown>,
  ctx: MemoryToolContext
): Promise<string> {
  try {
    switch (name) {
      case 'record_memory': {
        const i = input as {
          type: MemoryType
          key: string
          value: string
          confidence?: number
        }
        const entry = await memory.recordMemory({
          tenantId: ctx.tenantId,
          type: i.type,
          key: i.key,
          value: i.value,
          confidence: i.confidence,
          sourceRunId: ctx.runId,
        })
        return `Recorded memory ${entry.type}/${entry.key} (confidence ${entry.confidence}, evidence=${entry.evidenceCount})`
      }

      case 'query_memory': {
        const i = input as { type?: MemoryType; limit?: number }
        const entries = await memory.queryMemory({
          tenantId: ctx.tenantId,
          type: i.type,
          limit: i.limit ?? 10,
        })
        if (entries.length === 0) return 'No memories matched.'
        return entries
          .map((e) => `[${e.type}/${e.key}] ${e.value} (confidence ${e.confidence}, n=${e.evidenceCount})`)
          .join('\n')
      }

      case 'scratchpad_write': {
        const i = input as { key: string; value: string }
        await memory.scratchpadAppend({
          runId: ctx.runId,
          key: i.key,
          value: i.value,
        })
        return `Scratchpad note saved under key "${i.key}".`
      }

      case 'scratchpad_read': {
        const i = input as { key?: string }
        const entries = i.key
          ? await memory.scratchpadReadByKey(ctx.runId, i.key)
          : await memory.scratchpadReadAll(ctx.runId)
        if (entries.length === 0) return 'Scratchpad is empty.'
        const rendered = entries
          .map((e) => `[${e.key}] ${typeof e.value === 'string' ? e.value : JSON.stringify(e.value)}`)
          .join('\n')
        if (rendered.length > SCRATCHPAD_OUTPUT_CAP) {
          return rendered.slice(0, SCRATCHPAD_OUTPUT_CAP - 1) + '…'
        }
        return rendered
      }

      default:
        return `Unknown memory tool: ${name}`
    }
  } catch (err) {
    return `Memory tool error: ${String(err)}`
  }
}
