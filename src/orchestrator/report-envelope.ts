// src/orchestrator/report-envelope.ts
//
// Phase 4, Lever 2 — schema-validated outputs (scoped down from the old
// rollout 4).
//
// We validate the *envelope* of the aggregator's FinalReport — the kind
// discriminator plus the presence/shape of the structural fields the
// renderers depend on — NOT the free-form prose inside (titles, summaries,
// rationale strings). That decision is carried over from the old roadmap:
// deep-validating prose is too restrictive for synthesis output and buys
// nothing, while a loose `typeof x === 'string'` check (the prior
// validateMinimal) produced a useless "minimal_shape_validation_failed"
// reason that told neither us nor the retry prompt what was actually wrong.
//
// Zod gives us a precise, path-anchored error string instead, which:
//   1. surfaces loudly in logs (not just "the agent failed"), and
//   2. is fed verbatim into the aggregator's one-shot repair retry, so the
//      model is told exactly which field it botched.
//
// String fields are validated as non-empty where the renderer assumes
// content; arrays are validated as arrays but their elements are passed
// through (.passthrough on the element shape) so prose stays unconstrained.

import { z } from 'zod'
import type { FinalReport } from '../core/slack/blocks/types'

const nonEmpty = z.string().min(1)

// Element shapes are intentionally permissive: require nothing structural,
// let the renderer stay defensive about optional fields. We only assert the
// container is an array of objects.
const looseItem = z.array(z.object({}).passthrough())

const adHocEnvelope = z.object({
  kind:     z.literal('ad_hoc'),
  title:    nonEmpty,
  tldr:     z.array(z.string()).min(1),
  broken:   looseItem,
  working:  looseItem,
  leverage: looseItem,
}).passthrough()

const adHocTightEnvelope = z.object({
  kind:    z.literal('ad_hoc_tight'),
  title:   nonEmpty,
  summary: nonEmpty,
  why:     nonEmpty,
}).passthrough()

const dailyEnvelope = z.object({
  kind:             z.literal('daily'),
  tldr:             z.array(z.string()).min(1),
  shippedActions:   z.array(z.unknown()),
  newOpportunities: z.array(z.unknown()),
  queuedForToday:   z.array(z.unknown()),
  awaitingApproval: z.array(z.unknown()),
}).passthrough()

const weeklyEnvelope = z.object({
  kind:            z.literal('weekly'),
  tldr:            z.array(z.string()).min(1),
  topPriorities:   z.array(z.unknown()),
  clusterProgress: z.array(z.unknown()),
}).passthrough()

const reportEnvelope = z.discriminatedUnion('kind', [
  adHocEnvelope,
  adHocTightEnvelope,
  dailyEnvelope,
  weeklyEnvelope,
])

export type EnvelopeResult =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * Validate the structural envelope of an (already identity-enriched)
 * FinalReport. On failure returns a compact, path-anchored reason suitable
 * both for logging and for feeding into the repair-retry prompt.
 */
export function validateReportEnvelope(report: FinalReport): EnvelopeResult {
  const parsed = reportEnvelope.safeParse(report)
  if (parsed.success) return { ok: true }

  const reason = parsed.error.issues
    .slice(0, 6)
    .map(i => {
      const path = i.path.length ? i.path.join('.') : '(root)'
      return `${path}: ${i.message}`
    })
    .join('; ')

  return { ok: false, reason: `envelope_validation_failed: ${reason}` }
}
