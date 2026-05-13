// src/lib/prompt-cache.ts
// Wraps system prompts and tool lists with Anthropic prompt-caching headers.
// Every anthropic.messages.create call should use these wrappers so that
// deterministic content (system prompts, tool definitions) hits the cache
// on repeated calls and reduces cost + latency.

import Anthropic from '@anthropic-ai/sdk'

type CacheControl = { type: 'ephemeral' }

/**
 * Wrap a system prompt string so the Anthropic API caches it.
 * Returns a system array with a single text block marked ephemeral.
 */
export function cachedSystem(
  text: string,
): Array<Anthropic.TextBlockParam & { cache_control?: CacheControl }> {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
}

/**
 * Mark the last tool definition for caching. The full tool list is
 * deterministic per (tenant, intent) pair, so it hits the cache on
 * repeated calls within the same task.
 *
 * Anthropic only allows cache_control on the last item in the tools
 * array. Everything before it is automatically included in the cached
 * prefix.
 */
export function cachedTools(
  tools: Anthropic.Tool[],
): Anthropic.Tool[] {
  if (!tools.length) return tools
  const rest = tools.slice(0, -1)
  const last = { ...tools[tools.length - 1], cache_control: { type: 'ephemeral' as const } }
  return [...rest, last] as Anthropic.Tool[]
}
