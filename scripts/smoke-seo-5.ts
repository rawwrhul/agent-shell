// scripts/smoke-seo-5.ts
//
// Pure-function smoke tests for the SEO-5 backlinks rollout. DB- and
// LLM-bound functions are validated by deployment verification, not here.
//
// Run: npx tsx scripts/smoke-seo-5.ts

import { TYPE_FRAMING } from '../src/core/outreach-drafter'
import {
  DEFAULT_DAILY_SEND_CAP, DEFAULT_COOL_OFF_DAYS,
} from '../src/core/outreach-safety'

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

// ── TYPE_FRAMING bug regression: targetSite must be interpolated ────────
// (originally the framing strings had `${input_targetSite()}` which
// evaluated to literal '{targetSite}' at module load; this regression
// suite catches a re-occurrence.)
{
  const site = 'examplesite.com'
  const framings = ['backlink_gap', 'unlinked_mention', 'lost_backlink', 'partnership'] as const
  for (const t of framings) {
    const text = TYPE_FRAMING[t](site)
    check(
      `TYPE_FRAMING[${t}] interpolates targetSite`,
      text.includes(site),
      `framing did not include "${site}"`,
    )
    check(
      `TYPE_FRAMING[${t}] has no literal {targetSite} leftover`,
      !text.includes('{targetSite}'),
      `framing still contains literal {targetSite} placeholder`,
    )
  }

  // haro is the only framing that intentionally does NOT mention the
  // target site (it's a content reply, not a site-targeted pitch).
  const haro = TYPE_FRAMING['haro'](site)
  check(
    `TYPE_FRAMING[haro] does not contain literal {targetSite}`,
    !haro.includes('{targetSite}'),
    `haro framing has leftover placeholder`,
  )
}

// ── outreach-safety constants ───────────────────────────────────────────
check(
  'DEFAULT_DAILY_SEND_CAP is reasonable',
  DEFAULT_DAILY_SEND_CAP === 20,
  `expected 20, got ${DEFAULT_DAILY_SEND_CAP}`,
)
check(
  'DEFAULT_COOL_OFF_DAYS is reasonable',
  DEFAULT_COOL_OFF_DAYS === 60,
  `expected 60, got ${DEFAULT_COOL_OFF_DAYS}`,
)

// ── Summary ─────────────────────────────────────────────────────────────
console.log('')
if (failed > 0) {
  console.log(`${RED}${failed} check(s) failed${RESET}`)
  process.exit(1)
} else {
  console.log(`${GREEN}all checks passed${RESET}`)
  process.exit(0)
}
