// src/skills/seo-technical-auditor/synthesis.ts
//
// The thin LLM layer of the auditor. Receives:
//   - All current findings (new + persistent)
//   - All resolved findings (for context — "what got fixed")
//   - Tenant memory snapshot (for context — what the agent already knows)
//
// Produces:
//   - Opportunity proposals — 3-7 grouped opportunities to file in
//     seo_opportunities. Each groups related findings (e.g. 24 duplicate
//     titles → ONE opportunity not 24).
//   - Narrative — 4-8 sentence plain-English audit summary. Goes to
//     tenant_memory key 'audit-summary'.
//
// Why grouping matters: without it, the daily run sees 47 individual
// opportunities and can't pick a coherent batch to work on. Grouped, it
// sees "fix duplicate titles across 24 menu pages" as one opportunity it
// can pitch as a single fix.

import Anthropic from '@anthropic-ai/sdk'
import { config } from '../../config'
import { logger } from '../../logger'
import { callAnthropic } from '../../lib/anthropic-call'
import type { ResolvedFinding, Severity } from './types'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

const SYNTHESIS_MODEL = 'claude-sonnet-4-5-20250929'  // matches AGENT_MODEL default tier
const MAX_TOKENS = 4_000

export interface OpportunityProposal {
  type:            string          // e.g. 'fix_duplicate_titles', 'add_internal_link', 'fix_broken_link'
  target:          string | null   // exemplar URL if applicable
  description:     string          // one-line operator-facing summary
  rationale:       string          // why this matters + evidence (cite finding count)
  priority:        Severity        // promoted from findings; capped to P2 at write time
  estimatedImpact: string | null   // optional — what we'd expect if fixed
  /** Which finding IDs this opportunity covers. The store layer back-links
   *  the *first* one to the opportunity (1:1 relation in the schema). */
  findingIds:      string[]
}

export interface SynthesisOutput {
  opportunities: OpportunityProposal[]
  narrative:     string
}

/**
 * Run the synthesis pass. Returns parsed output. On any LLM error or parse
 * failure, returns a degraded but valid output: ungrouped opportunities
 * (one per top-severity finding) and a templated narrative. Audit must not
 * fail just because the LLM hiccupped.
 */
export async function synthesizeAudit(args: {
  tenantId:           string
  tenantName:         string
  findings:           ResolvedFinding[]
  resolvedThisAudit:  ResolvedFinding[]
  inventorySummary:   string | null   // value from tenant_memory key 'site-inventory'
  brandMemorySummary: string | null   // any high-confidence tenant memory snippets
}): Promise<SynthesisOutput> {
  const findingsForLlm = args.findings
    .filter((f) => f.state !== 'ignored')
    .sort(bySeverity)
    .slice(0, 100)   // cap to keep prompt bounded; rare for tenants to exceed

  if (findingsForLlm.length === 0) {
    return {
      opportunities: [],
      narrative:     `[Audit ${today()}] No findings. Site is in good technical shape.`,
    }
  }

  const prompt = buildPrompt({
    tenantName:        args.tenantName,
    findings:          findingsForLlm,
    resolvedThisAudit: args.resolvedThisAudit,
    inventorySummary:  args.inventorySummary,
    brandMemory:       args.brandMemorySummary,
  })

  try {
    const resp = await callAnthropic(anthropic, {
      model:      SYNTHESIS_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }, { label: 'audit-synthesis' })

    const text = resp.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')

    const parsed = extractJson(text)
    if (!parsed) {
      logger.warn('audit_synthesis_parse_failed', {
        tenantId: args.tenantId, textPreview: text.slice(0, 300),
      })
      return degradedOutput(findingsForLlm)
    }
    return normalizeSynthesisOutput(parsed, findingsForLlm)
  } catch (err) {
    logger.warn('audit_synthesis_llm_failed', {
      tenantId: args.tenantId, err: String(err).slice(0, 300),
    })
    return degradedOutput(findingsForLlm)
  }
}

// ── Prompt construction ──────────────────────────────────────────────────

function buildPrompt(args: {
  tenantName:        string
  findings:          ResolvedFinding[]
  resolvedThisAudit: ResolvedFinding[]
  inventorySummary:  string | null
  brandMemory:       string | null
}): string {
  const findingsTable = args.findings.map((f) => {
    const detail = JSON.stringify(f.detail).slice(0, 300)
    return `[id:${f.id}] [${f.severity}] [${f.state}${f.weeksOpen > 1 ? `:w${f.weeksOpen}` : ''}] ${f.checkName} | ${f.targetUrl ?? '(no target)'}${f.relatedUrl ? ` → ${f.relatedUrl}` : ''} | ${detail}`
  }).join('\n')

  const resolvedSection = args.resolvedThisAudit.length
    ? `\n\nResolved since last audit (${args.resolvedThisAudit.length}):\n` +
      args.resolvedThisAudit.slice(0, 20).map((f) =>
        `- ${f.checkName} on ${f.targetUrl ?? '(unknown)'} (was open ${f.weeksOpen} week${f.weeksOpen === 1 ? '' : 's'})`,
      ).join('\n')
    : ''

  const inventorySection = args.inventorySummary
    ? `\nSite inventory: ${args.inventorySummary}`
    : ''

  const brandSection = args.brandMemory
    ? `\nTenant context: ${args.brandMemory.slice(0, 600)}`
    : ''

  return `You are the synthesis layer of a deterministic SEO auditor. Each finding below was produced by a rule-based check — they are facts, not opinions. Your job: group related findings into 3-7 actionable opportunities for the operator, and write a short audit narrative.

Tenant: ${args.tenantName}
${inventorySection}${brandSection}

Current findings (${args.findings.length}, sorted by severity):
${findingsTable}
${resolvedSection}

OUTPUT: a single JSON object, no preamble, no markdown fence. Schema:

{
  "opportunities": [
    {
      "type":            "fix_duplicate_titles" | "fix_broken_internal_link" | "fix_canonical_conflict" | "add_internal_link_to_orphan" | "add_missing_meta_description" | "add_missing_h1" | "add_to_sitemap" | "remove_from_sitemap" | "fix_multiple_h1" | "fix_duplicate_meta_descriptions" | "other",
      "target":          "<exemplar URL or null>",
      "description":     "<one-line, operator-facing, action-shaped>",
      "rationale":       "<why this matters — cite the finding count and severity>",
      "priority":        "P0" | "P1" | "P2",
      "estimatedImpact": "<one line of what we'd expect if fixed, or null>",
      "findingIds":      ["<id from [id:...] prefix on findings above>", ...]
    }
  ],
  "narrative": "<4-8 sentences, plain English, current state + persistent issues + what got resolved. No bullet points. Will be loaded as ambient L2 memory for future agent runs.>"
}

GROUPING RULES:
- A single 'duplicate_titles' finding covers many pages — that's ONE opportunity, not many.
- Multiple 'broken_internal_link' findings on different source pages can be grouped IF they share a common cause (e.g., all linking to a 404'd /old-url) — otherwise keep separate.
- Multiple 'orphan_page' findings can be grouped if a single internal-link addition could resolve several at once (e.g., a hub page linking to several orphans).
- Cap: max 7 opportunities. If there are more eligible groups, pick the highest-severity 7.
- For each opportunity, the priority MUST be the maximum severity among its included findings (capped at P0).
- findingIds MUST be picked from the [id:...] prefix on the findings listed above. Never invent IDs or leave the array empty.

TYPE MAPPING RULES (strict):
- orphan_page finding → 'add_internal_link_to_orphan'. NEVER 'add_to_sitemap'. Orphans are pages that exist and are reachable but have no internal links pointing to them; the fix is to link to them from an existing page.
- 'add_to_sitemap' is reserved for indexable pages missing from sitemap.xml. If no finding identifies such a page, do not use this type.

NARRATIVE RULES:
- Lead with the count of new + persistent findings. Mention severity distribution.
- Call out any P0 issues by name.
- Mention persistent issues that have been open ≥3 weeks (escalation candidates).
- Mention what was resolved since last audit, if anything.
- Plain prose. ~4-8 sentences. No markdown, no lists.

Return ONLY the JSON object. No explanation text before or after.`
}

// ── Output parsing ───────────────────────────────────────────────────────

function extractJson(text: string): Record<string, unknown> | null {
  // Try direct parse first.
  try { return JSON.parse(text) } catch { /* fall through */ }
  // Strip code fences if any.
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
  try { return JSON.parse(stripped) } catch { /* fall through */ }
  // Try to find the outermost {...}.
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)) } catch { /* give up */ }
  }
  return null
}

function normalizeSynthesisOutput(
  raw: Record<string, unknown>,
  findings: ResolvedFinding[],
): SynthesisOutput {
  const validFindingIds = new Set(findings.map((f) => f.id))
  const opps = Array.isArray(raw.opportunities) ? raw.opportunities : []
  const opportunities: OpportunityProposal[] = []

  for (const o of opps.slice(0, 7)) {
    if (!o || typeof o !== 'object') continue
    const obj = o as Record<string, unknown>
    const fids = Array.isArray(obj.findingIds)
      ? (obj.findingIds as unknown[])
          .filter((x): x is string => typeof x === 'string' && validFindingIds.has(x))
      : []
    if (fids.length === 0) continue  // opportunity with no real findings — skip

    opportunities.push({
      type:            typeof obj.type === 'string' ? obj.type : 'other',
      target:          typeof obj.target === 'string' ? obj.target : null,
      description:     typeof obj.description === 'string' ? obj.description.slice(0, 500) : '',
      rationale:       typeof obj.rationale === 'string' ? obj.rationale.slice(0, 1000) : '',
      priority:        normalizePriority(obj.priority),
      estimatedImpact: typeof obj.estimatedImpact === 'string' ? obj.estimatedImpact.slice(0, 300) : null,
      findingIds:      fids,
    })
  }

  const narrative = typeof raw.narrative === 'string'
    ? raw.narrative.slice(0, 1500)
    : degradedNarrative(findings)

  return { opportunities, narrative }
}

function normalizePriority(p: unknown): Severity {
  if (p === 'P0' || p === 'P1' || p === 'P2') return p
  if (p === 'P3') return 'P2'
  return 'P2'
}

// ── Degraded path: emit something useful even without LLM ────────────────

function degradedOutput(findings: ResolvedFinding[]): SynthesisOutput {
  // Group by check_name + severity; one opportunity per top-3 groups.
  const groups = new Map<string, ResolvedFinding[]>()
  for (const f of findings) {
    const key = `${f.checkName}:${f.severity}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(f)
  }
  const top = Array.from(groups.entries())
    .sort((a, b) => severityRank(b[1][0].severity) - severityRank(a[1][0].severity))
    .slice(0, 5)

  const opportunities: OpportunityProposal[] = top.map(([key, fs]) => ({
    type:            mapCheckToOpportunityType(fs[0].checkName),
    target:          fs[0].targetUrl,
    description:     `Resolve ${fs.length} ${fs[0].checkName.replace(/_/g, ' ')} finding${fs.length === 1 ? '' : 's'}`,
    rationale:       `Auditor flagged ${fs.length} ${fs[0].severity}-priority ${fs[0].checkName.replace(/_/g, ' ')} finding${fs.length === 1 ? '' : 's'}. Synthesis layer fell back to grouped output.`,
    priority:        fs[0].severity,
    estimatedImpact: null,
    findingIds:      fs.map((f) => f.id).slice(0, 20),
  }))

  return {
    opportunities,
    narrative: degradedNarrative(findings),
  }
}

function degradedNarrative(findings: ResolvedFinding[]): string {
  const counts: Record<Severity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 }
  let persistent = 0
  for (const f of findings) {
    counts[f.severity]++
    if (f.state === 'persistent') persistent++
  }
  const parts = [`[Audit ${today()}] ${findings.length} findings`]
  const sev: string[] = []
  if (counts.P0) sev.push(`P0: ${counts.P0}`)
  if (counts.P1) sev.push(`P1: ${counts.P1}`)
  if (counts.P2) sev.push(`P2: ${counts.P2}`)
  if (counts.P3) sev.push(`P3: ${counts.P3}`)
  if (sev.length) parts.push(`(${sev.join(', ')})`)
  if (persistent > 0) parts.push(`. ${persistent} persistent.`)
  return parts.join(' ') + '.'
}

// ── Helpers ──────────────────────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function severityRank(s: Severity): number {
  return s === 'P0' ? 0 : s === 'P1' ? 1 : s === 'P2' ? 2 : 3
}

function bySeverity(a: ResolvedFinding, b: ResolvedFinding): number {
  return severityRank(a.severity) - severityRank(b.severity)
}

function mapCheckToOpportunityType(checkName: string): string {
  switch (checkName) {
    case 'duplicate_titles':            return 'fix_duplicate_titles'
    case 'duplicate_meta_descriptions': return 'fix_duplicate_meta_descriptions'
    case 'broken_internal_link':        return 'fix_broken_internal_link'
    case 'canonical_conflict':          return 'fix_canonical_conflict'
    case 'orphan_page':                 return 'add_internal_link_to_orphan'
    case 'missing_meta_description':    return 'add_missing_meta_description'
    case 'missing_h1':                  return 'add_missing_h1'
    case 'multiple_h1':                 return 'fix_multiple_h1'
    case 'sitemap_inconsistency':       return 'fix_sitemap'
    default:                            return 'other'
  }
}
