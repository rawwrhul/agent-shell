// scripts/smoke-brief-and-cards.ts
//
// Pure-function tests for the business_brief + approval-card bundle.
// DB-bound behaviour (createApproval, linkApprovalToOpportunity) is
// validated in deployment verification.

import { TYPE_FRAMING } from '../src/core/outreach-drafter'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const RESET = '\x1b[0m'

let failed = 0
function check(name: string, pass: boolean, detail?: string): void {
  if (pass) console.log(`${GREEN}✓${RESET} ${name}`)
  else {
    console.log(`${RED}✗${RESET} ${name}${detail ? `  — ${detail}` : ''}`)
    failed++
  }
}

// ── TYPE_FRAMING still works post-bundle (regression) ────────────────────
{
  const text = TYPE_FRAMING['backlink_gap']('examplesite.com')
  check('TYPE_FRAMING regression: still interpolates targetSite',
    text.includes('examplesite.com') && !text.includes('{targetSite}'),
    'framing did not interpolate correctly')
}

// ── card-builder type-dispatch sanity ───────────────────────────────────
// Note: full card-builder testing requires DB access since createApproval
// is a DB call. Here we just confirm the module loads + exports.
try {
  // dynamic import — module loading validates the imports compile
  const m = require('../src/core/opportunity-bank/card-builder')
  check('card-builder module exports createApprovalCardsForSurfaced',
    typeof m.createApprovalCardsForSurfaced === 'function')
  check('card-builder module exports AUTO_EXECUTE_TYPES set',
    m.AUTO_EXECUTE_TYPES instanceof Set)
  check('AUTO_EXECUTE_TYPES is empty in v1 (intentional)',
    m.AUTO_EXECUTE_TYPES.size === 0)
} catch (err) {
  check('card-builder module loads cleanly', false, String(err).slice(0, 100))
}

// ── Operator tag formatting expectations ────────────────────────────────
// Validates the Slack mention syntax: <@U07A1B2C3DE> for valid ID,
// "Operator" fallback for null/invalid.
// (No way to test the private helper directly without exporting it —
//  this is validated indirectly when a card is generated in production.)

console.log('')
if (failed > 0) {
  console.log(`${RED}${failed} check(s) failed${RESET}`)
  process.exit(1)
} else {
  console.log(`${GREEN}all checks passed${RESET}`)
  process.exit(0)
}
