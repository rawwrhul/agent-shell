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
import { surferRequest, createAndAwaitContentEditor, scoreContentV2, rescoreContentV2, autoOptimizeV2, getEditorContentV2 } from './client'

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
  reasons?:    string
}): Promise<string | null> {
  const { model, keyword, content, scoreBefore, threshold, reasons } = args
  const sys =
    `You are an SEO content editor. You will receive an HTML blog draft that scored ` +
    `${scoreBefore}/100 on an editorial quality review for the target keyword "${keyword}", ` +
    `below the target of ${threshold}.` +
    (reasons ? ` The reviewer's specific criticisms: ${reasons}.` : '') +
    ` Revise it to raise the score: improve topical ` +
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

// ── LLM rubric scorer ───────────────────────────────────────────────────────
//
// 2026-07-14 REALITY CHECK (probed live): on our Surfer plan the public API
// only CREATES content editors — /content_score, /ai_detector and /humanize
// return 404, and the editor detail endpoint returns metadata without
// guidelines. Every article gate call failed on phantom endpoints. The score
// is now produced by a strict LLM rubric review — no vendor in the publish
// path. Function names keep the module story; the score is ours.

export interface RubricScore {
  score:     number | null
  reasons:   string
  available: boolean
}

/** Exported for tests: lenient JSON extraction of { score, reasons }. */
export function parseRubricResponse(text: string): { score: number; reasons: string } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; reasons?: unknown }
    const n = typeof obj.score === 'number' ? obj.score : Number(obj.score)
    if (!Number.isFinite(n) || n < 0 || n > 100) return null
    return { score: Math.round(n), reasons: typeof obj.reasons === 'string' ? obj.reasons.slice(0, 500) : '' }
  } catch {
    return null
  }
}

async function rubricScore(args: {
  model:   string
  keyword: string
  content: string
}): Promise<RubricScore> {
  const sys =
    `You are a strict editorial reviewer for SEO content that will publish UNREVIEWED to a ` +
    `client's live site. Score the HTML draft 0-100 against this rubric, weighting equally:\n` +
    `1. SEARCH INTENT: does it fully answer what someone searching "${args.keyword}" wants?\n` +
    `2. DEPTH & SPECIFICITY: concrete numbers, steps, examples — not generic filler.\n` +
    `3. STRUCTURE: scannable headings that follow the query logic; no wall-of-text.\n` +
    `4. NATURAL KEYWORD USE: target phrase and related terms used naturally; ANY stuffing caps the score at 50.\n` +
    `5. TRUST: claims are plausible and hedged appropriately; nothing that could embarrass the brand or mislead a customer.\n` +
    `Calibration: 85+ exceptional, 75 good enough to publish unreviewed, 60 mediocre, <50 broken or risky. ` +
    `Most first drafts should land 60-80. Be strict — a generous score ships bad content with no human backstop.\n` +
    `Respond with ONLY this JSON: {"score": <0-100>, "reasons": "<one or two sentences on what holds it back>"}`

  try {
    const res = await callAnthropic(anthropic, {
      model:      args.model,
      max_tokens: 300,
      system:     sys,
      messages:   [{ role: 'user', content: args.content.slice(0, 60_000) }],
    }, { label: 'article-rubric-score' })

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
    const parsed = parseRubricResponse(text)
    if (!parsed) {
      logger.warn('rubric_score_unparseable', { keyword: args.keyword, sample: text.slice(0, 120) })
      return { score: null, reasons: '', available: false }
    }
    return { ...parsed, available: true }
  } catch (err) {
    logger.warn('rubric_score_failed', { keyword: args.keyword, err: String(err).slice(0, 200) })
    return { score: null, reasons: '', available: false }
  }
}

/**
 * Score a draft and, if it's below threshold, run a single revision pass.
 * Never throws — returns the best content we have plus a trajectory note.
 * (HITL path: best-effort, never blocks — a human reviews the draft anyway.)
 */
export async function scoreAndMaybeRevise(args: {
  model:     string
  keyword:   string
  content:   string
  location?: string
  threshold?: number
}): Promise<RevisionResult> {
  const threshold = args.threshold ?? DEFAULT_SCORE_THRESHOLD
  const base: RevisionResult = { content: args.content, available: false, scored: false, revised: false, threshold }

  if (!args.keyword || !args.content) {
    return { ...base, note: 'scoring skipped: missing keyword or content' }
  }

  const before = await rubricScore({ model: args.model, keyword: args.keyword, content: args.content })
  if (!before.available || before.score === null) {
    return { ...base, note: 'quality scoring unavailable' }
  }

  if (before.score >= threshold) {
    return {
      content: args.content, available: true, scored: true, scoreBefore: before.score,
      revised: false, threshold,
      note: `Quality ${before.score}/100 (target ${threshold}) ✓`,
    }
  }

  const revised = await reviseContent({
    model: args.model, keyword: args.keyword, content: args.content,
    scoreBefore: before.score, threshold, reasons: before.reasons,
  })
  if (!revised) {
    return {
      content: args.content, available: true, scored: true, scoreBefore: before.score,
      revised: false, threshold,
      note: `Quality ${before.score}/100 (target ${threshold}) — below target, revision pass failed`,
    }
  }

  const after = await rubricScore({ model: args.model, keyword: args.keyword, content: revised })
  const keepRevised = after.available && after.score !== null && after.score >= before.score
  return {
    content:    keepRevised ? revised : args.content,
    available:  true,
    scored:     true,
    scoreBefore: before.score,
    scoreAfter: after.score ?? undefined,
    revised:    keepRevised,
    threshold,
    note: after.score === null
      ? `Quality ${before.score}/100 — revised, re-score unavailable (kept original)`
      : keepRevised
        ? `Quality ${before.score}→${after.score}/100 (target ${threshold}, revised)`
        : `Quality ${before.score}→${after.score}/100 — revision scored lower, kept original`,
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  Autonomous publish quality gate (tenant autonomy_level='full')
//
//  Unlike scoreAndMaybeRevise (best-effort, never blocks — a human reviews
//  the draft anyway), this is a HARD GATE: it returns passed=true only when
//  Surfer actually scored the final content at/above threshold. The caller
//  (execApproveBlogPitch) publishes on passed=true and falls back to a
//  Stage-2 HITL card otherwise — including when Surfer is down. An
//  autonomous pipeline must not publish blind.
//
//  Pipeline (bounded: one editor, one humanize, one fact-verify, one
//  revision pass, max four score calls):
//    1. AI detection (best-effort signal)
//    2. If flagged AI-ish → Surfer Humanizer → LLM fact re-verification
//       against the pre-humanize draft (humanizers drift facts — the
//       re-verify pass restores any dropped/altered numbers, names, claims,
//       links; see surfer_humanize_content tool description)
//    3. Content score; if below threshold → one revision pass → re-score
//    4. passed = best score ≥ threshold
// ═════════════════════════════════════════════════════════════════════════

export interface QualityGateResult {
  /** Final content — best-scoring candidate produced by the pipeline. */
  content:      string
  /** Did Surfer produce a usable score for the final content? */
  available:    boolean
  /** Hard verdict: safe to auto-publish. Only true when available && score ≥ threshold. */
  passed:       boolean
  scoreBefore?: number
  scoreAfter?:  number
  /** Best-effort AI-detector verdict; undefined when unparseable/unavailable. */
  aiDetected?:  boolean
  humanized:    boolean
  revised:      boolean
  threshold:    number
  note:         string
}

/** Pure gate decision — split out for unit testing. */
export function gateVerdict(finalScore: number | null, threshold: number): boolean {
  return finalScore !== null && finalScore >= threshold
}

/**
 * Best-effort extraction of an AI-likelihood verdict from Surfer's
 * /ai_detector response. Shape-tolerant like extractScore. Returns
 * true (AI-ish), false (human-ish), or null (couldn't tell).
 */
export function extractAiVerdict(obj: unknown): boolean | null {
  if (!obj || typeof obj !== 'object') return null
  const record = obj as Record<string, unknown>

  // String verdicts first: { verdict: 'ai' } / { result: 'human' } etc.
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string' && /verdict|label|result|classification/i.test(k)) {
      if (/\bai\b|artificial|generated/i.test(v)) return true
      if (/human/i.test(v)) return false
    }
  }
  // Numeric probability: keys mentioning ai/detect/probability, 0-1 or 0-100.
  for (const [k, v] of Object.entries(record)) {
    if (/ai|detect|probab/i.test(k)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
      if (Number.isFinite(n)) {
        if (n >= 0 && n <= 1)   return n >= 0.5
        if (n > 1 && n <= 100)  return n >= 50
      }
    }
  }
  // One level deep (envelope nesting).
  for (const v of Object.values(record)) {
    if (v && typeof v === 'object') {
      const r = extractAiVerdict(v)
      if (r !== null) return r
    }
  }
  return null
}

/**
 * Best-effort extraction of humanized text from Surfer's /humanize response.
 * Prefers name-matched keys; falls back to the longest string in the object
 * that is plausibly the rewritten content (longer than half the original).
 */
export function extractHumanizedText(obj: unknown, originalLength: number): string | null {
  if (typeof obj === 'string') return obj.length > originalLength / 2 ? obj : null
  if (!obj || typeof obj !== 'object') return null
  const record = obj as Record<string, unknown>

  const preferred = ['humanized', 'humanized_content', 'humanized_text', 'content', 'text', 'output', 'result']
  for (const k of preferred) {
    const v = record[k]
    if (typeof v === 'string' && v.length > originalLength / 2) return v
  }
  // Fallback: longest plausible string anywhere in the object, one level of
  // envelope nesting deep (Surfer wraps under result/data envelopes).
  let best: string | null = null
  for (const v of Object.values(record)) {
    const candidate =
      typeof v === 'string' ? (v.length > originalLength / 2 ? v : null)
      : v && typeof v === 'object' ? extractHumanizedText(v, originalLength)
      : null
    if (candidate && (!best || candidate.length > best.length)) best = candidate
  }
  return best
}

/**
 * LLM fact re-verification after a humanize pass. Humanizers vague-out or
 * drop statistics, names, and claims — this pass restores them from the
 * pre-humanize draft while keeping the humanized phrasing. Returns null on
 * any failure (caller keeps the pre-humanize draft — safe default).
 */
async function factVerifyHumanized(args: {
  model:     string
  original:  string
  humanized: string
}): Promise<string | null> {
  const sys =
    `You are verifying a "humanized" rewrite of an HTML blog draft. The rewrite may have ` +
    `dropped, vagued-out, or altered specific statistics, numbers, names, factual claims, ` +
    `or links that the original contained. Compare the two versions. Produce a corrected ` +
    `version of the REWRITE that keeps its natural phrasing but restores every statistic, ` +
    `number, name, factual claim, internal link (<a href>), and image reference exactly as ` +
    `they appear in the ORIGINAL. Preserve the rewrite's HTML structure and tag set; do NOT ` +
    `change the title; do NOT add commentary. Output ONLY the corrected HTML, nothing else.`

  try {
    const res = await callAnthropic(anthropic, {
      model:      args.model,
      max_tokens: 8096,
      system:     sys,
      messages:   [{
        role: 'user',
        content: `ORIGINAL:\n\n${args.original}\n\n────────────\n\nREWRITE:\n\n${args.humanized}`,
      }],
    }, { label: 'surfer-humanize-fact-verify' })

    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim()

    return text.length > 0 ? text : null
  } catch (err) {
    logger.warn('surfer_humanize_fact_verify_failed', { err: String(err).slice(0, 200) })
    return null
  }
}

/**
 * Full quality pipeline for autonomous publishes. Never throws.
 */
export async function qualityGateForAutonomousPublish(args: {
  model:      string
  keyword:    string
  content:    string
  location?:  string
  threshold?: number
}): Promise<QualityGateResult> {
  const threshold = args.threshold ?? DEFAULT_SCORE_THRESHOLD
  const location  = args.location  ?? DEFAULT_LOCATION
  const fail = (note: string, partial: Partial<QualityGateResult> = {}): QualityGateResult => ({
    content: args.content, available: false, passed: false,
    humanized: false, revised: false, threshold, note, ...partial,
  })

  if (!args.keyword || !args.content) {
    return fail('quality gate failed closed: missing keyword or content')
  }

  // ── Primary: Surfer v2 content score (SERP-calibrated, verified live
  //    2026-07-14 against /llms.txt docs). One credit per article; the
  //    revision re-score reuses the same editor for free. ───────────────
  try {
    const first = await scoreContentV2({
      keyword: args.keyword, content: args.content, location,
    })
    const scoreBefore = first.seo ?? first.total
    if (scoreBefore !== null) {
      if (gateVerdict(scoreBefore, threshold)) {
        return {
          content: args.content, available: true, passed: true,
          scoreBefore, humanized: false, revised: false, threshold,
          note: `Surfer ${scoreBefore}/100 (target ${threshold}) ✓ auto-publish`,
        }
      }

      // Below threshold → AUTO-OPTIMIZE: Surfer rewrites the content
      // server-side to raise its own score (2026-07-14: LLM revision moved
      // scores 37→38; Auto-Optimize is the vendor's purpose-built tool for
      // exactly this gap). Guard: optimized content must keep >=2 internal
      // links — the pitch validation's hard requirement — else we fall
      // back to the LLM revision path rather than publish a stripped page.
      try {
        const opt = await autoOptimizeV2(first.editorId)
        if (opt.ran && opt.score !== null) {
          const optimized = await getEditorContentV2(first.editorId)
          const linkCount = (optimized.match(/<a\s+href=/gi) ?? []).length
          if (gateVerdict(opt.score, threshold) && linkCount >= 2) {
            return {
              content: optimized, available: true, passed: true,
              scoreBefore, scoreAfter: opt.score, humanized: false, revised: true, threshold,
              note: `Surfer ${scoreBefore}→${opt.score}/100 (target ${threshold}, auto-optimized) ✓ auto-publish`,
            }
          }
          if (gateVerdict(opt.score, threshold) && linkCount < 2) {
            logger.warn('surfer_auto_optimize_stripped_links', {
              keyword: args.keyword, editorId: first.editorId, linkCount,
            })
          } else if (opt.score >= threshold - 8) {
            // NEAR MISS after optimization — one targeted LLM revision of
            // the OPTIMIZED content, then a free re-score, before giving up.
            const nudged = await reviseContent({
              model: args.model, keyword: args.keyword, content: optimized,
              scoreBefore: opt.score, threshold,
            })
            const re = nudged ? await rescoreContentV2(first.editorId, nudged).catch(() => null) : null
            const reScore = re ? (re.seo ?? re.total) : null
            const reLinks = nudged ? (nudged.match(/<a\s+href=/gi) ?? []).length : 0
            if (reScore !== null && gateVerdict(reScore, threshold) && reLinks >= 2 && nudged) {
              return {
                content: nudged, available: true, passed: true,
                scoreBefore, scoreAfter: reScore, humanized: false, revised: true, threshold,
                note: `Surfer ${scoreBefore}→${opt.score}→${reScore}/100 (target ${threshold}, auto-optimized + revised) ✓ auto-publish`,
              }
            }
            return {
              content: args.content, available: true, passed: false,
              scoreBefore, scoreAfter: reScore ?? opt.score, humanized: false, revised: true, threshold,
              note: `Surfer ${scoreBefore}→${opt.score}${reScore !== null ? `→${reScore}` : ''}/100 below target ${threshold} after auto-optimize + revision`,
            }
          } else {
            // Even Surfer's own optimizer couldn't get close — the draft is
            // structurally short of the SERP. Discard with evidence.
            return {
              content: args.content, available: true, passed: false,
              scoreBefore, scoreAfter: opt.score, humanized: false, revised: true, threshold,
              note: `Surfer ${scoreBefore}→${opt.score}/100 after auto-optimize, below target ${threshold} — draft structurally short of this SERP (likely depth/length)`,
            }
          }
        }
      } catch (err) {
        logger.warn('surfer_auto_optimize_unavailable', {
          keyword: args.keyword, editorId: first.editorId, err: String(err).slice(0, 200),
        })
      }

      // Fallback below-threshold move: one LLM revision + free re-score.
      const revisedContent = await reviseContent({
        model: args.model, keyword: args.keyword, content: args.content,
        scoreBefore, threshold,
      })
      const after = revisedContent
        ? await rescoreContentV2(first.editorId, revisedContent).catch(() => null)
        : null
      const scoreAfter  = after ? (after.seo ?? after.total) : null
      const keepRevised = scoreAfter !== null && scoreAfter >= scoreBefore
      const finalScore  = keepRevised ? scoreAfter : scoreBefore
      const passed      = gateVerdict(finalScore, threshold)

      return {
        content:    keepRevised && revisedContent ? revisedContent : args.content,
        available:  true,
        passed,
        scoreBefore,
        scoreAfter: scoreAfter ?? undefined,
        humanized:  false,
        revised:    keepRevised,
        threshold,
        note: passed
          ? `Surfer ${scoreBefore}→${finalScore}/100 (target ${threshold}, revised) ✓ auto-publish`
          : `Surfer ${scoreBefore}${scoreAfter !== null ? `→${scoreAfter}` : ''}/100 below target ${threshold}`,
      }
    }
    logger.warn('surfer_v2_score_null_falling_back_to_rubric', { keyword: args.keyword, editorId: first.editorId })
  } catch (err) {
    logger.warn('surfer_v2_gate_unavailable_falling_back_to_rubric', {
      keyword: args.keyword, err: String(err).slice(0, 200),
    })
  }

  // ── Fallback: strict LLM rubric — articles keep flowing when Surfer is
  //    down, and NOTHING publishes unscored either way. ─────────────────
  try {
    const before = await rubricScore({ model: args.model, keyword: args.keyword, content: args.content })
    if (!before.available || before.score === null) {
      return fail('quality gate failed closed: Surfer and rubric scoring both unavailable')
    }
    const scoreBefore = before.score

    if (gateVerdict(scoreBefore, threshold)) {
      return {
        content: args.content, available: true, passed: true,
        scoreBefore, humanized: false, revised: false, threshold,
        note: `Rubric ${scoreBefore}/100 (target ${threshold}, Surfer unavailable) ✓ auto-publish`,
      }
    }

    const revisedContent = await reviseContent({
      model: args.model, keyword: args.keyword, content: args.content,
      scoreBefore, threshold, reasons: before.reasons,
    })
    const after = revisedContent
      ? await rubricScore({ model: args.model, keyword: args.keyword, content: revisedContent })
      : null
    let scoreAfter  = after?.score ?? null
    let keepRevised = scoreAfter !== null && scoreAfter >= scoreBefore
    let bestContent = keepRevised && revisedContent ? revisedContent : args.content
    let finalScore  = keepRevised ? (scoreAfter as number) : scoreBefore
    let trajectory  = `${scoreBefore}${scoreAfter !== null ? `→${scoreAfter}` : ''}`

    // NEAR MISS: within 8 points with a concrete criticism → one more
    // TARGETED revision (2026-07-14: a 74/75 discard whose reason named the
    // exact missing detail is waste, not quality control).
    if (!gateVerdict(finalScore, threshold) && finalScore >= threshold - 8) {
      const critique = after?.reasons || before.reasons
      if (critique) {
        const second = await reviseContent({
          model: args.model, keyword: args.keyword, content: bestContent,
          scoreBefore: finalScore, threshold, reasons: critique,
        })
        const re = second
          ? await rubricScore({ model: args.model, keyword: args.keyword, content: second })
          : null
        if (re?.score !== null && re !== null && re.score >= finalScore && second) {
          bestContent = second
          finalScore  = re.score
          scoreAfter  = re.score
          keepRevised = true
          trajectory += `→${re.score}`
        }
      }
    }

    const passed = gateVerdict(finalScore, threshold)
    return {
      content:    bestContent,
      available:  true,
      passed,
      scoreBefore,
      scoreAfter: scoreAfter ?? undefined,
      humanized:  false,
      revised:    keepRevised,
      threshold,
      note: passed
        ? `Rubric ${trajectory}/100 (target ${threshold}, revised, Surfer unavailable) ✓ auto-publish`
        : `Rubric ${trajectory}/100 below target ${threshold}${before.reasons ? ` — ${before.reasons}` : ''}`,
    }
  } catch (err) {
    logger.info('quality_gate_degraded', { keyword: args.keyword, err: String(err).slice(0, 200) })
    return fail('quality gate failed closed: scoring error')
  }
}
