// src/integrations/googleads/budget-changes.ts
//
// Deterministic layer for campaign daily budget changes (chunk 1d).
//
// Mechanism reminder: diagnose the impression-share loss type FIRST.
//   lost IS to BUDGET  -> budget is the right lever (this action)
//   lost IS to RANK    -> bids are the right lever (ads_change_bids)
//   both near zero     -> hold; nothing is constrained
//
// The executor enforces that discipline: increases are only shipped when
// search_budget_lost_impression_share >= 5% over the last 30 days and the
// loss is not rank-dominant. Decreases are always allowed within bounds.
// The 50% relative step cap applies in both directions. Shared budgets are
// refused outright - changing one silently changes sibling campaigns.

import { z } from 'zod'
import { toMicros, resources, type MutateOperation } from 'google-ads-api'

export const BUDGET_MIN = 1
export const BUDGET_MAX = 10000
export const MAX_RELATIVE_BUDGET_STEP = 0.5
export const BUDGET_LOST_IS_FLOOR = 0.05

export const BudgetChangeInputSchema = z.object({
  campaign_id:      z.coerce.number().int().positive(),
  new_daily_budget: z.coerce.number()
    .min(BUDGET_MIN, `daily budget below ${BUDGET_MIN}`)
    .max(BUDGET_MAX, `daily budget above ${BUDGET_MAX}`),
  rationale:        z.string().max(500).optional(),
})

export type BudgetChangeInput = z.infer<typeof BudgetChangeInputSchema>

export type BudgetIncreaseDiagnosis = 'increase_ok' | 'rank_dominant' | 'no_lost_is'

/**
 * Pure diagnosis of whether a budget INCREASE is the right lever, from the
 * campaign's 30-day impression-share loss split. Both inputs are ratios in
 * [0, 0.9+] as returned by the API.
 */
export function diagnoseBudgetIncrease(
  budgetLostIs: number,
  rankLostIs:   number,
): BudgetIncreaseDiagnosis {
  if (rankLostIs > budgetLostIs) return 'rank_dominant'
  if (budgetLostIs < BUDGET_LOST_IS_FLOOR) return 'no_lost_is'
  return 'increase_ok'
}

export function buildBudgetUpdateOp(
  budgetResourceName: string,
  newDailyBudget:     number,
): MutateOperation<resources.ICampaignBudget> {
  return {
    entity:    'campaign_budget',
    operation: 'update',
    resource:  {
      resource_name: budgetResourceName,
      amount_micros: toMicros(newDailyBudget),
    },
  }
}
