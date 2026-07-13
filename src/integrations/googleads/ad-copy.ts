// src/integrations/googleads/ad-copy.ts
//
// Deterministic layer for responsive search ad copy (chunk 1e). RSAs are
// immutable - "updating" copy means creating a NEW ad and (optionally)
// pausing the old one, atomically in one mutate request.
//
// Copy discipline: angles and value props come from SERP research; never
// literal competitor text. Google's own hard limits are enforced here so a
// policy bounce never reaches the operator: 3-15 headlines of <=30 chars
// (no exclamation marks), 2-4 descriptions of <=90 chars, https final URL,
// display paths <=15 chars.

import { z } from 'zod'
import { ResourceNames, enums, resources, type MutateOperation } from 'google-ads-api'

export const MIN_HEADLINES = 3
export const MAX_HEADLINES = 15
export const MAX_HEADLINE_CHARS = 30
export const MIN_DESCRIPTIONS = 2
export const MAX_DESCRIPTIONS = 4
export const MAX_DESCRIPTION_CHARS = 90
export const MAX_PATH_CHARS = 15

const HeadlineSchema = z.string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string()
    .min(1, 'headline is empty')
    .max(MAX_HEADLINE_CHARS, `headline exceeds ${MAX_HEADLINE_CHARS} characters`)
    .refine((s) => !s.includes('!'), 'Google rejects exclamation marks in headlines'))

const DescriptionSchema = z.string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string()
    .min(1, 'description is empty')
    .max(MAX_DESCRIPTION_CHARS, `description exceeds ${MAX_DESCRIPTION_CHARS} characters`))

const PathSchema = z.string()
  .transform((s) => s.trim())
  .pipe(z.string()
    .min(1, 'path is empty')
    .max(MAX_PATH_CHARS, `path exceeds ${MAX_PATH_CHARS} characters`)
    .refine((s) => !/[\s/]/.test(s), 'paths cannot contain spaces or slashes'))

function uniqueCaseInsensitive(items: string[], label: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  for (const t of items) {
    const key = t.toLowerCase()
    if (seen.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate ${label}: "${t}"` })
    }
    seen.add(key)
  }
}

export const AdCopyInputSchema = z.object({
  campaign_id: z.coerce.number().int().positive(),
  ad_group_id: z.coerce.number().int().positive(),
  headlines:   z.array(HeadlineSchema)
    .min(MIN_HEADLINES, `at least ${MIN_HEADLINES} headlines required`)
    .max(MAX_HEADLINES, `max ${MAX_HEADLINES} headlines`)
    .superRefine((h, ctx) => uniqueCaseInsensitive(h, 'headline', ctx)),
  descriptions: z.array(DescriptionSchema)
    .min(MIN_DESCRIPTIONS, `at least ${MIN_DESCRIPTIONS} descriptions required`)
    .max(MAX_DESCRIPTIONS, `max ${MAX_DESCRIPTIONS} descriptions`)
    .superRefine((d, ctx) => uniqueCaseInsensitive(d, 'description', ctx)),
  final_url:   z.string()
    .url('final_url must be a valid URL')
    .refine((u) => u.startsWith('https://'), 'final_url must be https'),
  path1:       PathSchema.optional(),
  path2:       PathSchema.optional(),
  pause_ad_id: z.coerce.number().int().positive().optional(),
  rationale:   z.string().max(500).optional(),
}).superRefine((v, ctx) => {
  if (v.path2 != null && v.path1 == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'path2 requires path1' })
  }
})

export type AdCopyInput = z.infer<typeof AdCopyInputSchema>

export function buildCreateRsaOp(
  customerId: string,
  input:      AdCopyInput,
): MutateOperation<resources.IAdGroupAd> {
  return {
    entity:    'ad_group_ad',
    operation: 'create',
    resource: {
      ad_group: ResourceNames.adGroup(customerId, input.ad_group_id),
      status:   enums.AdGroupAdStatus.ENABLED,
      ad: {
        final_urls: [input.final_url],
        responsive_search_ad: {
          headlines:    input.headlines.map((text) => ({ text })),
          descriptions: input.descriptions.map((text) => ({ text })),
          ...(input.path1 != null ? { path1: input.path1 } : {}),
          ...(input.path2 != null ? { path2: input.path2 } : {}),
        },
      },
    },
  }
}

export function buildPauseAdOp(
  customerId: string,
  adGroupId:  number,
  adId:       number,
): MutateOperation<resources.IAdGroupAd> {
  return {
    entity:    'ad_group_ad',
    operation: 'update',
    resource: {
      resource_name: ResourceNames.adGroupAd(customerId, adGroupId, adId),
      status:        enums.AdGroupAdStatus.PAUSED,
    },
  }
}
