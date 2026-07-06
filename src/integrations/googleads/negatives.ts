// src/integrations/googleads/negatives.ts
//
// Deterministic layer for the negative-keywords action (chunk 1b). The LLM
// proposes { scope, ids, keywords }; everything that touches the API is
// validated and constructed here. No LLM-generated value reaches the API
// without passing this schema.
//
// Mechanism reminder: negatives target HIGH-SPEND LOW-CONVERSION search
// terms (mined via google_ads_search_terms), not high-CPC ones.

import { z } from 'zod'
import { ResourceNames, enums, resources, type MutateOperation } from 'google-ads-api'

export const MAX_NEGATIVES_PER_PROPOSAL = 20
const MAX_KEYWORD_CHARS = 80
const MAX_KEYWORD_WORDS = 10

const MatchType = z.enum(['EXACT', 'PHRASE', 'BROAD'])

const KeywordSchema = z.object({
  text: z.string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string()
      .min(1, 'keyword text is empty')
      .max(MAX_KEYWORD_CHARS, `keyword exceeds ${MAX_KEYWORD_CHARS} characters`)
      .refine((s) => s.split(' ').length <= MAX_KEYWORD_WORDS, `keyword exceeds ${MAX_KEYWORD_WORDS} words`)
      .refine((s) => !/[<>{}\\|~^%!@*;=\[\]]/.test(s), 'keyword contains characters Google Ads rejects')),
  match_type: MatchType,
})

export const NegativeKeywordsInputSchema = z.object({
  scope:       z.enum(['campaign', 'ad_group']),
  campaign_id: z.coerce.number().int().positive(),
  ad_group_id: z.coerce.number().int().positive().optional(),
  keywords:    z.array(KeywordSchema).min(1, 'at least one keyword required').max(MAX_NEGATIVES_PER_PROPOSAL, `max ${MAX_NEGATIVES_PER_PROPOSAL} keywords per proposal`),
  rationale:   z.string().max(500).optional(),
}).superRefine((v, ctx) => {
  if (v.scope === 'ad_group' && !v.ad_group_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'ad_group_id is required when scope is ad_group' })
  }
})

export type NegativeKeywordsInput = z.infer<typeof NegativeKeywordsInputSchema>

const MATCH_ENUM: Record<z.infer<typeof MatchType>, enums.KeywordMatchType> = {
  EXACT:  enums.KeywordMatchType.EXACT,
  PHRASE: enums.KeywordMatchType.PHRASE,
  BROAD:  enums.KeywordMatchType.BROAD,
}

/** Dedupe case-insensitively on text+match_type, preserving first occurrence. */
export function dedupeKeywords(
  keywords: NegativeKeywordsInput['keywords'],
): NegativeKeywordsInput['keywords'] {
  const seen = new Set<string>()
  const out: NegativeKeywordsInput['keywords'] = []
  for (const k of keywords) {
    const key = `${k.match_type}:${k.text.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(k)
  }
  return out
}

export function buildCampaignNegativeOps(
  customerId: string,
  input: NegativeKeywordsInput,
): MutateOperation<resources.ICampaignCriterion>[] {
  const campaign = ResourceNames.campaign(customerId, input.campaign_id)
  return dedupeKeywords(input.keywords).map((k) => ({
    entity:    'campaign_criterion',
    operation: 'create',
    resource: {
      campaign,
      negative: true,
      keyword: { text: k.text, match_type: MATCH_ENUM[k.match_type] },
    },
  }))
}

export function buildAdGroupNegativeOps(
  customerId: string,
  input: NegativeKeywordsInput,
): MutateOperation<resources.IAdGroupCriterion>[] {
  const ad_group = ResourceNames.adGroup(customerId, input.ad_group_id!)
  return dedupeKeywords(input.keywords).map((k) => ({
    entity:    'ad_group_criterion',
    operation: 'create',
    resource: {
      ad_group,
      negative: true,
      keyword: { text: k.text, match_type: MATCH_ENUM[k.match_type] },
    },
  }))
}
