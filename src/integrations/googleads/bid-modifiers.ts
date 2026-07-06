// src/integrations/googleads/bid-modifiers.ts
//
// Deterministic layer for device bid modifiers (chunk 1c). The LLM proposes
// { ad_group_id, modifiers: [{ device, modifier }] }; bounds and op
// construction live here. No LLM-generated number reaches the API without
// passing the schema's range check.
//
// Google's device modifier range is -90% to +900%, i.e. 0.10 to 10.00 as a
// multiplier. A modifier of exactly 0 opts the device out entirely - that
// is a bigger decision than a bid nudge, so it is deliberately NOT allowed
// through this action; propose it as a manual_operator_task instead.
//
// Create vs update: an ad group has at most one modifier per device. The
// executor reads existing modifiers first and routes each proposal to
// 'update' (device already has one) or 'create' (it does not).

import { z } from 'zod'
import { ResourceNames, enums, resources, type MutateOperation } from 'google-ads-api'

export const MAX_MODIFIERS_PER_PROPOSAL = 3
export const MODIFIER_MIN = 0.1
export const MODIFIER_MAX = 10.0

const DeviceName = z.enum(['MOBILE', 'DESKTOP', 'TABLET'])
export type DeviceNameT = z.infer<typeof DeviceName>

const ModifierSchema = z.object({
  device:   DeviceName,
  modifier: z.coerce.number()
    .min(MODIFIER_MIN, `modifier below Google's minimum ${MODIFIER_MIN} (-90%)`)
    .max(MODIFIER_MAX, `modifier above Google's maximum ${MODIFIER_MAX} (+900%)`)
    .transform((v) => Math.round(v * 100) / 100),
})

export const BidModifiersInputSchema = z.object({
  campaign_id: z.coerce.number().int().positive(),
  ad_group_id: z.coerce.number().int().positive(),
  modifiers:   z.array(ModifierSchema)
    .min(1, 'at least one modifier required')
    .max(MAX_MODIFIERS_PER_PROPOSAL, `max ${MAX_MODIFIERS_PER_PROPOSAL} modifiers per proposal (one per device)`)
    .superRefine((mods, ctx) => {
      const seen = new Set<string>()
      for (const m of mods) {
        if (seen.has(m.device)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate device ${m.device}` })
        }
        seen.add(m.device)
      }
    }),
  rationale:   z.string().max(500).optional(),
})

export type BidModifiersInput = z.infer<typeof BidModifiersInputSchema>

export const DEVICE_ENUM: Record<DeviceNameT, enums.Device> = {
  MOBILE:  enums.Device.MOBILE,
  DESKTOP: enums.Device.DESKTOP,
  TABLET:  enums.Device.TABLET,
}

/** Map of device name -> existing modifier criterion id (from the pre-read). */
export type ExistingModifiers = Partial<Record<DeviceNameT, { criterionId: string; modifier: number }>>

export function buildBidModifierOps(
  customerId: string,
  input:      BidModifiersInput,
  existing:   ExistingModifiers,
): MutateOperation<resources.IAdGroupBidModifier>[] {
  const adGroup = ResourceNames.adGroup(customerId, input.ad_group_id)
  return input.modifiers.map((m) => {
    const prior = existing[m.device]
    if (prior) {
      return {
        entity:    'ad_group_bid_modifier' as const,
        operation: 'update' as const,
        resource: {
          resource_name: ResourceNames.adGroupBidModifier(customerId, input.ad_group_id, prior.criterionId),
          bid_modifier:  m.modifier,
        },
      }
    }
    return {
      entity:    'ad_group_bid_modifier' as const,
      operation: 'create' as const,
      resource: {
        ad_group:     adGroup,
        device:       { type: DEVICE_ENUM[m.device] },
        bid_modifier: m.modifier,
      },
    }
  })
}
