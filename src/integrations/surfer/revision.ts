// src/integrations/surfer/revision.ts
//
// Phase 4, Lever 1 — pre-HITL revision loop.
//
// Flow: draft → Surfer content score → if below threshold, ONE automatic
// revision pass with score feedback → re-score → keep the better version →
// surface the score trajectory on the approval card. Turns the HITL gate from
// "human checks the vibe" into "human approves against an objective benchmark."
//
// GRACEFUL DEGRADATION (the Voyage pattern): Surfer's API is access-gated
// (Custom Plan / API add-on), so this whole path is best-effort and NEVER
// throws into the caller. If the key is unconfigured, the editor times out,
// the response shape drifts, or anything else fails, we return the ORIGINAL
// content with `available:false` and the executor proceeds exactly as it did
// before this feature existed. A drafting pipeline must never be blocked by a
// scoring vendor being down.
//
// COST/TIME BOUNDS: the SERP scrape behind a content editor is the expensive
// step (~2 min). We create the editor ONCE and score both the original and
// the revised draft against it, and we cap revision at a single pass. Worst
// case added latency on a post-approval async executor: one scrape + two
// score calls + one ≤8k-token rewrite.

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../config'
import { logger } from '../../logger'
import { callAnthropic } from '../../lib/anthropic-call'
import { surferRequest, createAndAwaitContentEditor } from './client'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

export const DEFAULT_SCORE_THRESHOLD = 75
// Surfer scopes the SERP analysis to a market. Platform default is Australia
// (matches the DataForSEO location_code=2036 convention). Caller can override.
const DEFAULT_LOCATION = 'Australia'

export interface RevisionResult {
  /** Final content to draft — the original, or the revision if it scored higher. */
  content:      string
  /** Was Surfer reachable + configured? false → everything below is unset. */
  available:    boolean
  /** Did we get a usable numeric score for the original? */
  scored:       boolean
  scoreBefore?: number
  scoreAfter?:  number
  /** Did a revision pass run AND get kept? */
  revised:      boolean
  threshold:    number
  /** Short human-readable note for logs + the approval card. */
  note?:        string
}

/**
 * Pull the first plausible 0–100 content score out of Surfer's response.
 * Shape-tolerant by design (see client.ts): we walk the object for a numeric
 * field whose key looks score-ish, preferring `content_score`.
 */
export function extractScore(obj: unknown): number | null {
  if (!obj || typeof obj !== 'object') return null
  const preferred = ['content_score', 'contentScore', 'score', 'overall_score', 'overallScore']
  const record = obj as Record<string, unknown>

  for (const k of preferred) {
    const v = record[k]
    const n = toScore(v)
    if (n !== null) return n
  }
  // Fallback: any key containing "score" with a numeric value in range.
  for (const [k, v] of Object.entries(record)) {
    if (/score/i.test(k)) {
      const n = toScore(v)
      if (n !== null) return n
    }
  }
  // One level deep (Surfer sometimes nests under a result/data envelope).
  for (const v of Object.values(record)) {
    if (v && typeof v === 'object') {
      const n = extractScore(v)
      if (n !== null) return n
    }
  }
  return null
}

function toScore(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  if (n < 0 || n > 100) return null
  return Math.round(n)
}

async function scoreAgainstEditor(editorId: string | number, content: string): Promise<number | null> {
  const scored = await surferRequest('POST', `/content_editors/${editorId}/content_score`, { content })
  return extractScore(scored)
}

function editorIdOf(editor: unknown): string | number | null {
  if (!editor || typeof editor !== 'object') return null
  const e = editor as Record<string, unknown>
  const direct = e.id
  if (typeof direct === 'string' || typeof direct === 'number') return direct
  const nested = (e.content_editor as { id?: unknown } | undefined)?.id
  if (typeof nested === 'string' || typeof nested === 'number') return nested
  return null
}

async function reviseContent(args: {
  model:       string
  keyword:     string
  content:     string
  scoreBefore: number
  threshold:   number
}): Promise<string | null> {
  const { model, keyword, content, scoreBefore, threshold } = args
  const sys =
    `You are an SEO content editor. You will receive an HTML blog draft that scored ` +
    `${scoreBefore}/100 on SurferSEO's content score for the target keyword "${keyword}", ` +
    `below the target of ${threshold}. Revise it to raise the score: improve topical ` +
    `coverage and natural use of the target keyword and closely-related terms, tighten ` +
    `structure, and ensure headings and depth match search intent. ` +
    `HARD CONSTRAINTS: preserve the exact HTML structure and tag set; do NOT remove or ` +
    `alter any factual claims, statistics, names, or links; do NOT change the title; ` +
    `do NOT add commentary. Output ONLY the revised HTML, nothing else.`

  try {
    const res = await callAnthropic(anthropic, {
      model,
      max_tokens: 8096,
      system:     sys,
      messages:   [{ role: 'user', content }],
    }, { label: 'surfer-revision' })

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    return text.length > 0 ? text : null
  } catch (err) {
    logger.warn('surfer_revision_rewrite_failed', { err: String(err).slice(0, 200) })
    return null
  }
}

/**
 * Score a draft and, if it's below threshold, run a single revision pass.
 * Never throws — returns the best content we have plus a trajectory note.
 */
export async function scoreAndMaybeRevise(args: {
  model:     string
  keyword:   string
  content:   string
  location?: string
  threshold?: number
}): Promise<RevisionResult> {
  const threshold = args.threshold ?? DEFAULT_SCORE_THRESHOLD
  const location  = args.location  ?? DEFAULT_LOCATION
  const base: RevisionResult = { content: args.content, available: false, scored: false, revised: false, threshold }

  if (!args.keyword || !args.content) {
    return { ...base, note: 'scoring skipped: missing keyword or content' }
  }

  try {
    const editor = await createAndAwaitContentEditor(args.keyword, location)
    const editorId = editorIdOf(editor)
    if (editorId === null) {
      logger.info('surfer_revision_unavailable', { reason: 'no_editor_id', keyword: args.keyword })
      return { ...base, note: 'Surfer scoring unavailable (editor id not resolved)' }
    }

    const scoreBefore = await scoreAgainstEditor(editorId, args.content)
    if (scoreBefore === null) {
      return { ...base, available: true, note: 'Surfer scoring unavailable (no score in response)' }
    }

    // Above threshold → ship as-is.
    if (scoreBefore >= threshold) {
      return {
        content: args.content, available: true, scored: true, scoreBefore,
        revised: false, threshold,
        note: `Surfer ${scoreBefore}/100 (target ${threshold}) ✓`,
      }
    }

    // Below → one revision pass.
    const revised = await reviseContent({ model: args.model, keyword: args.keyword, content: args.content, scoreBefore, threshold })
    if (!revised) {
      return {
        content: args.content, available: true, scored: true, scoreBefore,
        revised: false, threshold,
        note: `Surfer ${scoreBefore}/100 (target ${threshold}) — below target, revision pass failed`,
      }
    }

    const scoreAfter = await scoreAgainstEditor(editorId, revised)
    // Keep whichever scored higher; protect the customer from a worse rewrite.
    const keepRevised = scoreAfter !== null && scoreAfter >= scoreBefore
    return {
      content:    keepRevised ? revised : args.content,
      available:  true,
      scored:     true,
      scoreBefore,
      scoreAfter: scoreAfter ?? undefined,
      revised:    keepRevised,
      threshold,
      note: scoreAfter === null
        ? `Surfer ${scoreBefore}/100 — revised, re-score unavailable (kept original)`
        : keepRevised
          ? `Surfer ${scoreBefore}→${scoreAfter}/100 (target ${threshold}, revised)`
          : `Surfer ${scoreBefore}→${scoreAfter}/100 — revision scored lower, kept original`,
    }
  } catch (err) {
    // Missing key throws here ("Surfer API key not configured"), as does any
    // network/shape failure. Degrade silently to the original draft.
    logger.info('surfer_revision_degraded', { keyword: args.keyword, err: String(err).slice(0, 200) })
    return { ...base, note: 'Surfer scoring unavailable' }
  }
}
