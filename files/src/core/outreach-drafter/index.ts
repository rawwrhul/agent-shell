// src/core/outreach-drafter/index.ts
//
// Shared outreach email drafter used by SEO-5 discovery skills. Generates
// a subject + body + recipient-field-placeholder for an outreach prospect
// based on type-specific framing.
//
// Two prospect-type-specific drafting modes for MVP:
//
//   - 'backlink_gap'      — competitor links to {target_site}; we don't.
//                           Pitch: "saw your piece on X, we have related
//                           content that complements it"
//   - 'unlinked_mention'  — {target_site} mentioned our brand but didn't
//                           link. Pitch: "thanks for the mention; would
//                           you mind adding a link to our page on Y?"
//
// Output structure stored on the opportunity's `detail` JSONB:
//
//   {
//     prospect_type, target_site, target_url_idea, pitch_angle,
//     drafted_subject, drafted_body, recipient_email_field
//   }
//
// `recipient_email_field` is a placeholder like 'TO_BE_PROVIDED_BY_OPERATOR'.
// The MVP UX is: operator pastes the contact email into the Approvals
// Sheet next to the draft, then approves. Phase 2 can add Hunter.io.

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../config'
import { logger } from '../../logger'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
const DRAFT_MODEL = 'claude-sonnet-4-5-20250929'

export type OutreachProspectType =
  | 'backlink_gap'
  | 'unlinked_mention'
  | 'lost_backlink'
  | 'haro'
  | 'partnership'

export interface DraftInput {
  prospectType:  OutreachProspectType
  /** The site we're pitching (e.g. 'techblog.com'). */
  targetSite:    string
  /** Optional URL on the target site we want to reference (e.g. their
   *  article on a topic where our content would fit naturally). */
  targetUrl:     string | null
  /** Our tenant's name (for sign-off / context). */
  tenantName:    string
  /** Our tenant's domain (so the email can link to us correctly). */
  tenantDomain:  string
  /** Optional URL on our site we want them to link to or reference. */
  ourUrl:        string | null
  /** Free-text context the discovery skill provides — e.g. for
   *  backlink_gap, "they linked to competitor X with anchor 'best CRMs'";
   *  for unlinked_mention, "they mentioned us in this paragraph: '...'" */
  context:       string
}

export interface DraftOutput {
  subject:               string
  body:                  string
  pitchAngle:            string
  recipientEmailField:   'TO_BE_PROVIDED_BY_OPERATOR'
}

/**
 * Generate an outreach email. Returns null on any LLM failure — the
 * caller should still file the opportunity (without the draft) so the
 * operator sees the prospect even without a polished pitch.
 */
export async function draftOutreach(input: DraftInput): Promise<DraftOutput | null> {
  const prompt = buildPrompt(input)

  try {
    const resp = await anthropic.messages.create({
      model:      DRAFT_MODEL,
      max_tokens: 1500,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')

    const parsed = extractJson(text)
    if (!parsed) return null
    if (typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') return null

    return {
      subject:             parsed.subject.slice(0, 200),
      body:                parsed.body.slice(0, 5000),
      pitchAngle:          typeof parsed.pitchAngle === 'string' ? parsed.pitchAngle.slice(0, 300) : '',
      recipientEmailField: 'TO_BE_PROVIDED_BY_OPERATOR',
    }
  } catch (err) {
    logger.warn('outreach_draft_llm_failed', {
      prospectType: input.prospectType,
      targetSite:   input.targetSite,
      err:          String(err).slice(0, 200),
    })
    return null
  }
}

// ── Prompt construction ─────────────────────────────────────────────────

function buildPrompt(input: DraftInput): string {
  const framingFn = TYPE_FRAMING[input.prospectType] ?? GENERIC_FRAMING
  const typeFraming = framingFn(input.targetSite)

  return `You are drafting a real outreach email from ${input.tenantName} to the editor / owner of ${input.targetSite}. The email must read like a thoughtful operator wrote it — not like a generic SEO outreach template. No "I hope this email finds you well." No "I came across your incredible article." No flattery. No hype words.

${typeFraming}

Context from the discovery skill:
${input.context}

Our site: ${input.tenantDomain}
${input.ourUrl ? `Our specific page we'd reference: ${input.ourUrl}` : ''}
${input.targetUrl ? `Their specific page we're responding to: ${input.targetUrl}` : ''}

Constraints:
- Short. Aim for 4–6 sentences in the body. Maximum 150 words.
- One specific ask. The reader knows by sentence 2 what we want.
- Reference one concrete detail from their content (not generic praise).
- Sign off with the tenant name (${input.tenantName}). No company tagline.
- Do NOT include a P.S.
- Do NOT use "leverage", "synergy", "value-add", "circle back", em dashes, or any other consulting-deck-speak.
- Do NOT begin with "I'm writing to" or "I hope this email finds you well" — start with the substance.

Return ONLY a JSON object, no preamble:

{
  "subject":    "<short subject, no clickbait>",
  "body":       "<the email body, plain text, line-break-separated paragraphs>",
  "pitchAngle": "<one-line internal note explaining why we think this will land>"
}`
}

const GENERIC_FRAMING = (_targetSite: string): string =>
  `This is an outreach email asking for a backlink or partnership consideration.`

export const TYPE_FRAMING: Record<OutreachProspectType, (targetSite: string) => string> = {
  backlink_gap: (targetSite) =>
    `Type: BACKLINK GAP. ${targetSite} has linked to a competitor of ours but not to us. The email should not mention the competitor explicitly — that's rude and tips our hand. Instead, the email should reference the specific topic/page on the target site, briefly explain why our content adds something complementary (not duplicate), and ask politely whether they'd consider adding a link in a future update or new piece.`,

  unlinked_mention: (targetSite) =>
    `Type: UNLINKED MENTION. ${targetSite} mentioned our brand in their content but didn't include a link. The email should: thank them genuinely for the mention (one sentence — don't gush), note that we noticed and we'd love for readers to be able to click through, and ask if they'd be open to adding the link the next time they're updating the piece. This is the warmest of the prospect types — the relationship is half-built already.`,

  lost_backlink: (targetSite) =>
    `Type: LOST BACKLINK. ${targetSite} used to link to us but the link is gone (page was deleted, restructured, or the link was removed). The email should: note we noticed the change (without being aggressive), check whether the link was intentionally removed, and offer to provide an updated URL if the original page moved.`,

  haro: (_targetSite) =>
    `Type: HARO RESPONSE. We're responding to a HARO query they posted. The email should directly answer what they asked, provide a concrete piece of expert insight, and include the credentials/context the operator wants attributed. Keep credentials brief — one sentence.`,

  partnership: (targetSite) =>
    `Type: PARTNERSHIP. We're proposing some form of mutual benefit (content swap, co-marketing, etc.) to ${targetSite}. The email should: explain the specific value to them in the first two sentences (not generic), propose one concrete next step, and make it easy to say no without further obligation.`,
}

function extractJson(text: string): {
  subject?: unknown; body?: unknown; pitchAngle?: unknown
} | null {
  try { return JSON.parse(text) } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
  try { return JSON.parse(stripped) } catch { /* fall through */ }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* give up */ }
  }
  return null
}
