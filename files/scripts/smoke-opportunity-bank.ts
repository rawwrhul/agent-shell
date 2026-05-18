// scripts/smoke-opportunity-bank.ts
//
// Stand-alone smoke test. Tests pure functions only (scoring, diversity,
// flat-rejection detection). DB-bound functions (select, transitions,
// reshape, ad-hoc-match) are exercised in deployment validation.
//
// Run: tsx scripts/smoke-opportunity-bank.ts
// Or:  npm run smoke:opportunity-bank

import { scoreAndPick } from '../src/core/opportunity-bank/select'
import { isFlatRejection } from '../src/core/opportunity-bank/reshape'
import type { Opportunity, Priority } from '../src/core/opportunity-bank/types'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

let failed = 0
function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`${GREEN}✓${RESET} ${name}`)
  } else {
    console.log(`${RED}✗${RESET} ${name}${detail ? `  — ${detail}` : ''}`)
    failed++
  }
}

function mkOpp(args: {
  id: string
  type: string
  priority: Priority
  ageMs?: number
}): Opportunity {
  const ageMs = args.ageMs ?? 0
  return {
    id:              args.id,
    tenantId:        'test',
    runId:           'test-run',
    type:            args.type,
    target:          null,
    description:     `desc-${args.id}`,
    rationale:       null,
    priority:        args.priority,
    status:          'new',
    estimatedImpact: null,
    createdAt:       new Date(Date.now() - ageMs),
    updatedAt:       new Date(Date.now() - ageMs),
    surfacedInRunId: null,
    surfacedAt:      null,
    dismissedReason: null,
    reshapeSourceId: null,
    reshapeTargetId: null,
    reshapeCount:    0,
    resolvedRunId:   null,
  }
}

// ── scoreAndPick — priority dominates when ages match ─────────────────────
{
  const opps = [
    mkOpp({ id: 'a', type: 'fix_x', priority: 'P2' }),
    mkOpp({ id: 'b', type: 'fix_y', priority: 'P0' }),
    mkOpp({ id: 'c', type: 'fix_z', priority: 'P1' }),
  ]
  const picked = scoreAndPick(opps, 3, 2)
  check('priority ordering: P0 > P1 > P2', picked[0].id === 'b' && picked[1].id === 'c' && picked[2].id === 'a',
    `got order: ${picked.map((p) => p.id).join(',')}`)
}

// ── scoreAndPick — diversity cap kicks in ─────────────────────────────────
{
  const opps = [
    mkOpp({ id: 'a', type: 'fix_x', priority: 'P0' }),
    mkOpp({ id: 'b', type: 'fix_x', priority: 'P0' }),
    mkOpp({ id: 'c', type: 'fix_x', priority: 'P0' }),  // 3rd of same type — should be capped out
    mkOpp({ id: 'd', type: 'fix_y', priority: 'P1' }),
  ]
  const picked = scoreAndPick(opps, 4, 2)
  check('diversity cap at 2 per type', picked.length === 3,
    `expected 3 picked (cap drops 1), got ${picked.length}`)
  const fixXCount = picked.filter((p) => p.type === 'fix_x').length
  check('cap respected on dominant type', fixXCount === 2,
    `expected 2 of fix_x, got ${fixXCount}`)
  check('overflow drops the lowest-scored same-type', !picked.some((p) => p.id === 'c'),
    `expected c to be dropped`)
}

// ── scoreAndPick — limit honoured ─────────────────────────────────────────
{
  const opps = [
    mkOpp({ id: 'a', type: 'a', priority: 'P0' }),
    mkOpp({ id: 'b', type: 'b', priority: 'P0' }),
    mkOpp({ id: 'c', type: 'c', priority: 'P0' }),
    mkOpp({ id: 'd', type: 'd', priority: 'P0' }),
  ]
  const picked = scoreAndPick(opps, 2, 2)
  check('limit caps total picks', picked.length === 2,
    `expected 2 picked, got ${picked.length}`)
}

// ── scoreAndPick — age boost lifts fresh P1 above old P0 (sanity) ─────────
{
  const opps = [
    mkOpp({ id: 'fresh-p1', type: 'a', priority: 'P1', ageMs: 0 }),
    // P0 old enough that ageBoost halves it: P0 weight 10 × 0.5 = 5, vs P1 weight 6 × 1.0 = 6.
    mkOpp({ id: 'old-p0',   type: 'b', priority: 'P0', ageMs: 30 * 24 * 3600 * 1000 }),
  ]
  const picked = scoreAndPick(opps, 2, 2)
  check('fresh P1 outranks aged-out P0', picked[0].id === 'fresh-p1',
    `got first: ${picked[0]?.id}`)
}

// ── scoreAndPick — empty input ────────────────────────────────────────────
{
  const picked = scoreAndPick([], 5, 2)
  check('empty input returns empty', picked.length === 0)
}

// ── isFlatRejection ───────────────────────────────────────────────────────
check('null reason is flat', isFlatRejection(null) === true)
check('empty string is flat', isFlatRejection('') === true)
check('whitespace-only is flat', isFlatRejection('   \n  ') === true)
check('"no" alone is flat', isFlatRejection('no') === true)
check('"never" is flat', isFlatRejection('never') === true)
check('"nope" is flat', isFlatRejection('nope') === true)
check('"not relevant" is flat', isFlatRejection('not relevant') === true)
check('substantive feedback is not flat',
  isFlatRejection('This pitch is too aggressive for our brand. Soften the tone.') === false)
check('medium-length real feedback is not flat',
  isFlatRejection('wrong target page — should be /pricing not /home') === false)
// A long reason containing "no" should still be substantive (length guard).
check('long reason with "no" inside is not flat',
  isFlatRejection('The angle is no good for B2B audiences. Try focusing on enterprise instead.') === false)

// ── Summary ───────────────────────────────────────────────────────────────

console.log('')
if (failed > 0) {
  console.log(`${RED}${failed} check(s) failed${RESET}`)
  process.exit(1)
} else {
  console.log(`${GREEN}all checks passed${RESET}`)
  process.exit(0)
}
