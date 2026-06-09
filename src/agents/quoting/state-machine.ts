// src/agents/quoting/state-machine.ts
//
// Pure state-machine definition for the quoting flow (build requirements §6).
// No I/O here — the store (store.ts) calls assertTransition() before it
// persists a state change, so an illegal transition fails loudly instead of
// silently corrupting a quote.
//
//   LEAD_CAPTURED -> OUTLINE_POSTED -> SITE_PRIMED -> SITE_CAPTURED
//                 -> QUOTE_BUILT -> APPROVED -> SENT
//   terminal alternates: REJECTED, EXPIRED (reachable from most live states)
//
// There is exactly ONE hard human-approval gate: APPROVED (before SENT). The
// pricing-confirm between SITE_CAPTURED and QUOTE_BUILT is conversational,
// not a formal gate.

export const QUOTE_STATES = [
  'LEAD_CAPTURED',
  'OUTLINE_POSTED',
  'SITE_PRIMED',
  'SITE_CAPTURED',
  'QUOTE_BUILT',
  'APPROVED',
  'SENT',
  'REJECTED',
  'EXPIRED',
] as const

export type QuoteState = (typeof QUOTE_STATES)[number]

export const TERMINAL_STATES: ReadonlySet<QuoteState> = new Set<QuoteState>([
  'SENT',
  'REJECTED',
  'EXPIRED',
])

// Allowed forward transitions. REJECTED/EXPIRED are appended to every
// non-terminal state below (a quote can be killed or expire at any live point).
const FORWARD: Record<QuoteState, QuoteState[]> = {
  LEAD_CAPTURED:  ['OUTLINE_POSTED'],
  OUTLINE_POSTED: ['SITE_PRIMED'],
  SITE_PRIMED:    ['SITE_CAPTURED'],
  SITE_CAPTURED:  ['QUOTE_BUILT'],
  QUOTE_BUILT:    ['APPROVED'],
  APPROVED:       ['SENT'],
  SENT:           [],
  REJECTED:       [],
  EXPIRED:        [],
}

const LIVE_STATES = QUOTE_STATES.filter((s) => !TERMINAL_STATES.has(s))

/** Full transition table including the universal kill/expire edges. */
export const TRANSITIONS: Record<QuoteState, ReadonlySet<QuoteState>> =
  QUOTE_STATES.reduce((acc, s) => {
    const next = new Set<QuoteState>(FORWARD[s])
    if (LIVE_STATES.includes(s)) {
      next.add('REJECTED')
      next.add('EXPIRED')
    }
    acc[s] = next
    return acc
  }, {} as Record<QuoteState, Set<QuoteState>>)

export function canTransition(from: QuoteState, to: QuoteState): boolean {
  return TRANSITIONS[from]?.has(to) ?? false
}

export class IllegalQuoteTransition extends Error {
  constructor(
    public readonly from: QuoteState,
    public readonly to: QuoteState,
  ) {
    super(`Illegal quote transition: ${from} -> ${to}`)
    this.name = 'IllegalQuoteTransition'
  }
}

export function assertTransition(from: QuoteState, to: QuoteState): void {
  if (!canTransition(from, to)) throw new IllegalQuoteTransition(from, to)
}

export function isTerminal(state: QuoteState): boolean {
  return TERMINAL_STATES.has(state)
}
