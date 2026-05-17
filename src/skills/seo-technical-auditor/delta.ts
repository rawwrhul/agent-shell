// src/skills/seo-technical-auditor/delta.ts
//
// Match current audit's findings against the prior audit's findings to
// compute state transitions:
//
//   - 'new'        — finding_key exists this audit, didn't exist prior
//   - 'persistent' — finding_key exists in both; increment weeks_open
//   - 'resolved'   — finding_key existed prior, doesn't exist now
//   - 'ignored'    — finding marked ignored by operator (preserved across audits)
//
// Severity escalation: persistent findings with weeks_open >= 3 get bumped
// one severity tier (capped at P0). This is the operator-pressure mechanism
// that escalates issues nobody's actioning.

import type { RawFinding, ResolvedFinding, Severity } from './types'

const ESCALATION_THRESHOLD_WEEKS = 3

/**
 * Resolve current findings against the prior snapshot. Returns:
 *   - resolved: array of {currentFindings + resolvedFindings} ready to upsert
 *   - resolvedKeys: finding_keys that existed prior but not now
 *
 * `resolved` is the union of:
 *   - current findings with state='new' or 'persistent'
 *   - prior findings that are now state='resolved'
 *   - prior findings with state='ignored' (passed through unchanged)
 */
export function computeDelta(args: {
  current: RawFinding[]
  prior:   Map<string, ResolvedFinding>
  now:     Date
}): { findings: ResolvedFinding[]; resolvedIds: { id: string; findingKey: string }[] } {
  const out: ResolvedFinding[] = []
  const currentKeys = new Set<string>()
  const resolvedIds: { id: string; findingKey: string }[] = []

  for (const c of args.current) {
    currentKeys.add(c.findingKey)
    const priorEntry = args.prior.get(c.findingKey)

    if (!priorEntry) {
      out.push({
        ...c,
        id:          '',
        state:       'new',
        firstSeenAt: args.now,
        lastSeenAt:  args.now,
        weeksOpen:   1,
      })
      continue
    }

    // Preserve 'ignored' state — operator decision sticks.
    if (priorEntry.state === 'ignored') {
      out.push({
        ...priorEntry,
        // Refresh the detail/severity from the current finding (rules may have changed),
        // but keep state ignored.
        detail:     c.detail,
        severity:   c.severity,
        targetUrl:  c.targetUrl,
        relatedUrl: c.relatedUrl,
        lastSeenAt: args.now,
      })
      continue
    }

    // Persistent — increment weeks_open and apply escalation if appropriate.
    const newWeeks = priorEntry.weeksOpen + 1
    const escalatedSeverity = newWeeks >= ESCALATION_THRESHOLD_WEEKS
      ? bumpSeverity(c.severity)
      : c.severity

    out.push({
      ...c,
      id:          priorEntry.id,
      state:       'persistent',
      firstSeenAt: priorEntry.firstSeenAt,
      lastSeenAt:  args.now,
      weeksOpen:   newWeeks,
      severity:    escalatedSeverity,
    })
  }

  // Resolved — prior findings not in current set, except 'ignored' ones (those persist forever).
  for (const [key, priorEntry] of args.prior) {
    if (currentKeys.has(key)) continue
    if (priorEntry.state === 'ignored') continue  // operator-ignored stays in place
    resolvedIds.push({ id: priorEntry.id, findingKey: key })
  }

  return { findings: out, resolvedIds }
}

function bumpSeverity(s: Severity): Severity {
  switch (s) {
    case 'P3': return 'P2'
    case 'P2': return 'P1'
    case 'P1': return 'P0'
    case 'P0': return 'P0'
  }
}
