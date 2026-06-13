// src/core/strategy/normalize.ts
//
// Phase 2, build unit 2: pure, defensive normalization of the LLM's proposed
// strategy core. The strategist authors free-form JSON; this clamps it to the
// typed shape so a malformed or runaway response can never poison the stored
// doc or break the cycles that read it. Always returns a valid StrategyCore
// plus a list of warnings (for logging). No I/O.

import {
  StrategyCore, PortfolioCluster, CompetitiveFront, StrategyConstraint,
  ClusterDisposition, CLUSTER_DISPOSITIONS,
  MAX_PORTFOLIO_CLUSTERS, MAX_TARGET_KEYWORDS, MAX_FRONTS, MAX_CONSTRAINTS,
  MAX_FIELD_CHARS,
} from './types'

const CONSTRAINT_KINDS = ['voice', 'no_go', 'decision', 'learning'] as const

export interface NormalizeResult {
  core:     StrategyCore
  warnings: string[]
}

export function normalizeStrategyCore(raw: unknown): NormalizeResult {
  const warnings: string[] = []
  const obj = isRecord(raw) ? raw : {}
  if (!isRecord(raw)) warnings.push('core was not an object; defaulted to empty')

  const portfolio = normalizePortfolio(obj.portfolio, warnings)
  const fronts    = normalizeFronts(obj.fronts, warnings)
  const constraints = normalizeConstraints(obj.constraints, warnings)

  return { core: { portfolio, fronts, constraints }, warnings }
}

// ── portfolio ──────────────────────────────────────────────────────────────

function normalizePortfolio(raw: unknown, warnings: string[]): PortfolioCluster[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('portfolio was not an array; dropped')
    return []
  }
  const out: PortfolioCluster[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (out.length >= MAX_PORTFOLIO_CLUSTERS) { warnings.push('portfolio truncated at cap'); break }
    if (!isRecord(item)) continue
    const topic = str(item.topic)
    if (!topic) continue
    const dedupeKey = topic.toLowerCase()
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    out.push({
      topic,
      disposition: disposition(item.disposition, warnings),
      priority:    priority(item.priority),
      targetKeywords: strArray(item.targetKeywords, MAX_TARGET_KEYWORDS),
      rationale:   optStr(item.rationale),
    })
  }
  // Re-number priority 1..n by the LLM's intended order (stable), so the
  // stored doc always has a clean ranking even if the model duplicated or
  // skipped numbers.
  out.sort((a, b) => a.priority - b.priority)
  out.forEach((c, i) => { c.priority = i + 1 })
  return out
}

function disposition(raw: unknown, warnings: string[]): ClusterDisposition {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if ((CLUSTER_DISPOSITIONS as readonly string[]).includes(v)) return v as ClusterDisposition
  warnings.push(`unknown disposition "${String(raw)}"; defaulted to grow`)
  return 'grow'
}

function priority(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 999
}

// ── fronts ───────────────────────────────────────────────────────────────

function normalizeFronts(raw: unknown, warnings: string[]): CompetitiveFront[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('fronts was not an array; dropped')
    return []
  }
  const out: CompetitiveFront[] = []
  for (const item of raw) {
    if (out.length >= MAX_FRONTS) { warnings.push('fronts truncated at cap'); break }
    if (!isRecord(item)) continue
    const competitor = str(item.competitor)
    const where = str(item.where)
    if (!competitor || !where) continue
    out.push({ competitor, where, winnable: Boolean(item.winnable), note: optStr(item.note) })
  }
  return out
}

// ── constraints ────────────────────────────────────────────────────────────

function normalizeConstraints(raw: unknown, warnings: string[]): StrategyConstraint[] {
  if (!Array.isArray(raw)) {
    if (raw !== undefined) warnings.push('constraints was not an array; dropped')
    return []
  }
  const out: StrategyConstraint[] = []
  for (const item of raw) {
    if (out.length >= MAX_CONSTRAINTS) { warnings.push('constraints truncated at cap'); break }
    if (!isRecord(item)) continue
    const value = str(item.value)
    if (!value) continue
    const kindRaw = typeof item.kind === 'string' ? item.kind.trim().toLowerCase() : ''
    const kind = (CONSTRAINT_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as StrategyConstraint['kind'])
      : 'learning'
    out.push({ kind, value })
  }
  return out
}

// ── helpers ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v.trim().slice(0, MAX_FIELD_CHARS)
}

function optStr(v: unknown): string | undefined {
  const s = str(v)
  return s ? s : undefined
}

function strArray(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of v) {
    if (out.length >= cap) break
    const s = str(item)
    if (!s) continue
    const k = s.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(s)
  }
  return out
}
