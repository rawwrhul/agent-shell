// src/agents/quoting/schemas.ts
//
// zod schemas for every quoting-agent output (build requirements §7). These
// are the contract: the PDF renderer (§10) consumes QuoteFinal, so every PDF
// cell originates in a field here. Validate every LLM extraction against the
// matching schema via the shared validate-with-retry helper
// (src/core/runtime/validate.ts, added in Chunk 2) before persisting.
//
// Money is NEVER emitted by the model. The deterministic rate-card calculator
// (Chunk 4) computes unitPrice/amount/subtotal/gst/total. The model proposes
// line items + quantities only; QuoteOutline carries ranges, not fixed prices.

import { z } from 'zod'
import { CATEGORIES, isKnownPair } from './taxonomy'

// ── Shared fragments ────────────────────────────────────────────────

const Customer = z.object({
  name:    z.string().optional(),
  address: z.string().optional(),
  phone:   z.string().optional(),
})

const Range = z.object({
  low:  z.number().nonnegative(),
  high: z.number().nonnegative(),
})

// ── Stage 1: extraction target from the lead voice note ─────────────

export const LeadIntakeSchema = z
  .object({
    customer: Customer,
    jobCategory:    z.enum(CATEGORIES as [string, ...string[]]),
    jobSubcategory: z.string().min(1),
    description:    z.string().min(1),
    siteAttributes: z.object({
      propertyType: z.string().optional(),
      phase:        z.enum(['single', 'three', 'unknown']).optional(),
      network:      z.string().optional(),
      storeys:      z.number().int().positive().optional(),
    }),
    workforce: z.object({
      crew: z
        .array(
          z.object({
            role:  z.enum(['L2_electrician', 'apprentice']),
            count: z.number().int().nonnegative(),
          }),
        )
        .default([]),
      estHours:               z.number().nonnegative().optional(),
      afterHours:             z.boolean().optional(),
      requiresEWP:            z.boolean().optional(),
      requiresTrafficControl: z.boolean().optional(),
    }),
    hardCosts: z
      .array(
        z.object({
          name: z.string().min(1),
          qty:  z.number().nonnegative().optional(),
          unit: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .default([]),
    accessRisks:   z.array(z.string()).default([]),
    openQuestions: z.array(z.string()).default([]),
    confidence:    z.enum(['low', 'medium', 'high']),
  })
  // Cross-field: subcategory must belong to the chosen category.
  .superRefine((val, ctx) => {
    if (!isKnownPair(val.jobCategory, val.jobSubcategory)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['jobSubcategory'],
        message: `"${val.jobSubcategory}" is not a valid subcategory of "${val.jobCategory}". Use one from the curated taxonomy.`,
      })
    }
  })
export type LeadIntake = z.infer<typeof LeadIntakeSchema>

// ── Stage 1: what gets posted to Slack as dot points ────────────────

export const QuoteOutlineSchema = z.object({
  category:         z.string().min(1),
  subcategory:      z.string().min(1),
  workforceSummary: z.string().min(1),
  hardCostEstimate: Range,
  labourEstimate:   Range,
  ballparkRange:    Range, // ALWAYS a range pre-site
  clarifyingQuestions: z.array(z.string()).default([]),
})
export type QuoteOutline = z.infer<typeof QuoteOutlineSchema>

// ── Issued at SITE_PRIMED (§9) ──────────────────────────────────────

export const SiteChecklistSchema = z.object({
  confirmItems: z.array(z.string()).default([]),
  upsellPrompts: z
    .array(
      z.object({
        name:      z.string().min(1),
        rationale: z.string().min(1),
      }),
    )
    .default([]),
})
export type SiteChecklist = z.infer<typeof SiteChecklistSchema>

// ── Stage 2: extraction target from on-site voice note(s) ───────────

export const SiteUpdateSchema = z.object({
  confirmedQuantities: z
    .array(
      z.object({
        name: z.string().min(1),
        qty:  z.number().nonnegative(),
        unit: z.string().min(1),
      }),
    )
    .default([]),
  scopeChanges:   z.array(z.string()).default([]),
  acceptedUpsells: z.array(z.string()).default([]),
  finalCrew: z
    .array(
      z.object({
        role:  z.string().min(1),
        count: z.number().int().nonnegative(),
        hours: z.number().nonnegative(),
      }),
    )
    .default([]),
  newRisksFound: z.array(z.string()).default([]),
})
export type SiteUpdate = z.infer<typeof SiteUpdateSchema>

// ── Final priced object == the PDF ──────────────────────────────────

export const QuoteLineItemSchema = z.object({
  kind:        z.enum(['labour', 'material', 'service', 'compliance', 'upsell']),
  description: z.string().min(1),
  detail:      z.string().optional(),
  qty:         z.number().nonnegative(),
  unit:        z.string().min(1),
  unitPrice:   z.number().nonnegative(),
  amount:      z.number().nonnegative(),
  optional:    z.boolean().optional(), // true for add-ons shown outside the total
})
export type QuoteLineItem = z.infer<typeof QuoteLineItemSchema>

export const QuoteFinalSchema = z.object({
  quoteNumber: z.string().min(1),
  issuedAt:    z.string().min(1), // ISO date string
  validDays:   z.number().int().positive(),
  customer: z.object({
    name:    z.string().min(1),
    address: z.string().min(1),
    phone:   z.string().optional(),
  }),
  job: z.object({
    category:       z.string().min(1),
    subcategory:    z.string().min(1),
    description:    z.string().min(1),
    siteAttributes: z.record(z.unknown()),
  }),
  lineItems:     z.array(QuoteLineItemSchema).min(1),
  subtotalExGst: z.number().nonnegative(),
  gst:           z.number().nonnegative(),
  totalIncGst:   z.number().nonnegative(),
  optionalAddOns: z.array(QuoteLineItemSchema).default([]),
  inclusions:  z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  exclusions:  z.array(z.string()).default([]),
})
export type QuoteFinal = z.infer<typeof QuoteFinalSchema>
