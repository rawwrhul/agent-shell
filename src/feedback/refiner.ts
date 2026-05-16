// src/feedback/refiner.ts
//
// Single Anthropic call that takes the current pitch + operator feedback
// and returns a structured refinement decision. No tools — pure text-in /
// JSON-out. Tool-enabled refinement (image swaps etc.) is future work.

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { logger } from '../logger'
import { REFINER_SYSTEM_PROMPT, buildRefinerUserMessage } from './prompts'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export interface RefinerInput {
  stage:        'stage1' | 'stage2'
  title:        string
  whyThisTopic: string
  content:      string
  feedback:     string
}

export interface RefinerOutput {
  action:        'refined' | 'clarify' | 'reject'
  updated?:      {
    title?:        string
    content?:      string
    whyThisTopic?: string
  }
  changeSummary: string
}

export async function runRefiner(input: RefinerInput): Promise<RefinerOutput> {
  const userMessage = buildRefinerUserMessage(input)

  const response = await anthropic.messages.create({
    model:      config.AGENT_MODEL ?? 'claude-sonnet-4-6',
    max_tokens: 4096,
    system:     REFINER_SYSTEM_PROMPT,
    messages:   [{ role: 'user', content: userMessage }],
  })

  const textBlock = response.content.find(b => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Refiner returned no text content')
  }

  // Strip any markdown fences the model might emit despite instructions.
  const raw = textBlock.text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '')
    .trim()

  let parsed: RefinerOutput
  try {
    parsed = JSON.parse(raw) as RefinerOutput
  } catch (err) {
    logger.error('refiner_json_parse_failed', { rawSnippet: raw.slice(0, 400), err: String(err) })
    throw new Error('Refiner returned invalid JSON')
  }

  // Defensive normalisation — action must be one of the three, change_summary must exist.
  if (!['refined', 'clarify', 'reject'].includes(parsed.action)) {
    logger.warn('refiner_unknown_action', { action: parsed.action })
    return { action: 'clarify', changeSummary: 'I produced an unrecognised response — could you rephrase the feedback?' }
  }
  if (typeof parsed.changeSummary !== 'string' || !parsed.changeSummary.trim()) {
    parsed.changeSummary = parsed.action === 'refined' ? 'Updated the pitch.' : 'No change made.'
  }

  return parsed
}
