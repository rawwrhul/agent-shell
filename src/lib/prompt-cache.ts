// src/lib/prompt-cache.ts
//
// Anthropic prompt-caching helpers.
//
// How prompt caching works at the API:
//   - You add `cache_control: { type: 'ephemeral' }` to ANY block (a system
//     text block, a tool definition, a message content block).
//   - That block AND everything BEFORE it in the same section becomes
//     eligible for caching.
//   - Up to 4 cache breakpoints per request. We use two: one on the system,
//     one on the last tool. That caches: the entire system prompt + ALL
//     tool definitions.
//   - Cached tokens cost 10% of regular input tokens.
//   - Cached tokens DON'T count against ITPM (input-tokens-per-minute) rate
//     limits.
//   - Cache TTL is ~5 minutes by default. As long as the same prefix is sent
//     within that window, you get the cache hit.
//
// What we DON'T cache:
//   - Messages. They change every turn (the conversation history grows).
//   - Anything per-request — but our system prompts and tool defs are
//     deterministic for a given tenant, so they cache cleanly across an
//     entire run.
//
// Per-iteration tokens for a typical subagent run:
//   Before caching:  ~10k tokens (system + tools) × 15 iterations = 150k
//                    input tokens, billed at full rate.
//   After caching:   10k tokens cached at iter 1 (full rate), then 10k
//                    cached-hit tokens × 14 iterations = 140k at 10% rate
//                    = effective ~24k full-rate-equivalent tokens.
//   Savings: ~6x reduction on prefix cost, plus the ITPM headroom matters
//   for longer runs.

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Wrap a system-prompt string in array form with a cache breakpoint.
 *
 * The Anthropic SDK accepts `system` as either a string or an array of
 * TextBlock-like objects. To attach cache_control, we need the array form.
 */
export function cachedSystem(text: string): Array<{
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}> {
  return [
    {
      type: 'text',
      text,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Add a cache breakpoint to the last tool in the array.
 *
 * The breakpoint caches everything up to and including this tool, which in
 * practice means "all tool definitions for this request." Tool defs are
 * static per tenant configuration, so the cache lasts the whole run.
 *
 * Returns a new array — does not mutate the input.
 */
export function cachedTools<T extends Anthropic.Tool>(tools: T[]): T[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [
    ...tools.slice(0, -1),
    {
      ...last,
      cache_control: { type: 'ephemeral' as const },
    },
  ];
}

/**
 * Add a *moving* cache breakpoint to the last block of the last message.
 *
 * System + tools are cached by the helpers above, but the conversation
 * history grows every iteration and was being re-billed at full rate —
 * which dominates cost on long audits (15+ turns). Putting a breakpoint on
 * the tail of the message list means that on the NEXT iteration the entire
 * prior conversation is a cached read (10% rate, no ITPM pressure), and only
 * the newly-appended turn is billed full. The breakpoint "moves" to the new
 * tail each call — standard incremental-conversation caching.
 *
 * Budget: the API allows 4 breakpoints. We use system (1) + tools (1) + this
 * (1) = 3, so this is always safe to add. Idempotent: if the last block is
 * already marked, returns the input untouched. Never mutates the input.
 *
 * Cheap calls (single user message, no reuse) get a harmless no-op breakpoint.
 */
export function withMovingMessageBreakpoint(
  messages: Anthropic.MessageParam[],
): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;

  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];

  // String content → wrap as a single cached text block.
  if (typeof last.content === 'string') {
    const rewritten: Anthropic.MessageParam = {
      role: last.role,
      content: [
        {
          type: 'text',
          text: last.content,
          cache_control: { type: 'ephemeral' },
        },
      ],
    };
    return [...messages.slice(0, lastIdx), rewritten];
  }

  const blocks = last.content;
  if (blocks.length === 0) return messages;

  const lastBlockIdx = blocks.length - 1;
  const lastBlock = blocks[lastBlockIdx];

  // Already cached → no-op (keeps us idempotent across re-wraps).
  if ('cache_control' in lastBlock && lastBlock.cache_control) return messages;

  const rewrittenBlocks: Anthropic.ContentBlockParam[] = [
    ...blocks.slice(0, lastBlockIdx),
    { ...lastBlock, cache_control: { type: 'ephemeral' } } as Anthropic.ContentBlockParam,
  ];

  const rewrittenMsg: Anthropic.MessageParam = { role: last.role, content: rewrittenBlocks };
  return [...messages.slice(0, lastIdx), rewrittenMsg];
}
