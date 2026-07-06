// src/integrations/googleads/keyword-edits.ts
//
// Deterministic layer for editing ACTIVE keywords (chunk 1c). Supported
// edits on an existing ad_group_criterion keyword:
//
//   pause    - status -> PAUSED
//   enable   - status -> ENABLED
//   set_cpc  - keyword-level CPC bid (manual CPC campaigns only; on Smart
//              Bidding campaigns the API accepts the value but ignores it,
//              so the executor pre-read flags non-manual campaigns)
//
// NOT supported here: changing keyword text or match type. Those fields
// are immutable on a criterion - Google requires remove + create, which is
// a different risk shape (history loss) and belongs to the expansion
// action in chunk 1e, not an edit.
//
// Money discipline: the agent proposes cpc in account-currency units; the
// schema bounds it and toMicros converts at the edge. No LLM-generated
// micros value ever reaches the API.

import { z } from 'zod'
import { ResourceNames, enums, toMicros, resources, type MutateOperation } from 'google-ads-api'

export const MAX_EDITS_PER_PROPOSAL = 20
export const CPC_MIN = 0.05
export const CPC_MAX = 200

const EditSchema = z.object({
  criterion_id: z.coerce.number().int().positive(),
  action:       z.enum(['pause', 'enable', 'set_cpc']),
  cpc:          z.coerce.number().min(CPC_MIN, `cpc below ${CPC_MIN}`).max(CPC_MAX, `cpc above ${CPC_MAX} - propose budget-level changes instead`).optional(),
}).superRefine((v, ctx) => {
  if (v.action === 'set_cpc' && v.cpc == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cpc is required when action is set_cpc' })
  }
  if (v.action !== 'set_cpc' && v.cpc != null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cpc is only valid with action set_cpc' })
  }
})

export const KeywordEditsInputSchema = z.object({
  campaign_id: z.coerce.number().int().positive(),
  ad_group_id: z.coerce.number().int().positive(),
  edits:       z.array(EditSchema)
    .min(1, 'at least one edit required')
    .max(MAX_EDITS_PER_PROPOSAL, `max ${MAX_EDITS_PER_PROPOSAL} edits per proposal`)
    .superRefine((edits, ctx) => {
      const seen = new Set<number>()
      for (const e of edits) {
        if (seen.has(e.criterion_id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate criterion_id ${e.criterion_id}` })
        }
        seen.add(e.criterion_id)
      }
    }),
  rationale:   z.string().max(500).optional(),
})

export type KeywordEditsInput = z.infer<typeof KeywordEditsInputSchema>
export type KeywordEdit = KeywordEditsInput['edits'][number]

export function buildKeywordEditOps(
  customerId: string,
  input:      KeywordEditsInput,
  edits:      KeywordEdit[] = input.edits,
): MutateOperation<resources.IAdGroupCriterion>[] {
  return edits.map((e) => {
    const resource_name = ResourceNames.adGroupCriterion(customerId, input.ad_group_id, e.criterion_id)
    if (e.action === 'set_cpc') {
      return {
        entity:    'ad_group_criterion' as const,
        operation: 'update' as const,
        resource:  { resource_name, cpc_bid_micros: toMicros(e.cpc!) },
      }
    }
    return {
      entity:    'ad_group_criterion' as const,
      operation: 'update' as const,
      resource:  {
        resource_name,
        status: e.action === 'pause' ? enums.AdGroupCriterionStatus.PAUSED : enums.AdGroupCriterionStatus.ENABLED,
      },
    }
  })
}
