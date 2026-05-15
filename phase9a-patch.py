#!/usr/bin/env python3
"""
phase9a-patch.py — Phase 9a: iteration cap raise + smart retries + tight ad-hoc response

Three changes:

  1. Item 6 — Raise propose_changes iteration cap from 15 to 25.
     Phase 8.5's research-first workflow requires ~7 deterministic tool calls
     (GSC, memory, framer_list, DataForSEO, pexels, framer_get_changed_paths,
     propose_action) leaving only 8 turns for actual research + drafting.
     Wall-clock + token ceiling remain as guard rails.

  2. Item 8 — Smart retries in execution worker.
     Classify FramerPluginError / typia validation / schema-shape errors as
     UnrecoverableError so BullMQ skips retries. Network / rate-limit / timeout
     errors stay retryable. Saves 2x wasted exec attempts + 2x failure noise
     in Slack on deterministic failures.

  3. Item 4 — Tight ad-hoc aggregator response shape.
     New FinalReport variant 'ad_hoc_tight' with just {title, summary, why,
     notes}. Used for Slack-mention runs that produce a single approval — no
     more TL;DR/What's working/What's broken/Top leverage report scaffolding
     overkill for "drafted you one post." Cron daily/weekly keeps the full
     report structure.

Run from project root. Idempotent.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path.cwd()
assert (ROOT / 'package.json').exists() and (ROOT / 'src').exists(), 'Run from project root.'

def must_read(p):
    if not p.exists(): sys.exit(f'fatal: file missing: {p}')
    return p.read_text()

def replace_one(text, anchor, new, where):
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:400]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── 1. ITEM 6: raise propose_changes iteration cap ─────────────────────────
P = ROOT / 'src/agents/intent-budgets.ts'
src = must_read(P)
if 'propose_changes:  25' in src:
    print('[1/5] intent-budgets.ts already raised — skipping')
else:
    src = replace_one(
        src,
        'propose_changes:  15',
        'propose_changes:  25',   # Phase 9a: research-first workflow needs more turns
        'intent-budgets.ts iteration cap',
    )
    P.write_text(src)
    print('[1/5] intent-budgets.ts — propose_changes cap raised 15 → 25')

# ── 2. ITEM 8: smart retries — classify errors in execution worker ─────────
P = ROOT / 'src/execution/worker.ts'
src = must_read(P)
if 'classifyExecutionError' in src or 'UnrecoverableError' in src:
    print('[2/5] execution worker already classifies errors — skipping')
else:
    # 2a. Add import for UnrecoverableError
    src = replace_one(
        src,
        "import { Worker, Job } from 'bullmq'",
        "import { Worker, Job, UnrecoverableError } from 'bullmq'",
        'worker.ts bullmq import',
    )
    # 2b. Insert classifier function near the top, after imports
    classifier_block = '''
// ── Phase 9a: smart retries — classify deterministic vs transient errors ──
//
// BullMQ retries on every throw. For deterministic errors (schema validation,
// missing fields, type mismatches) that won't resolve on retry, we throw
// UnrecoverableError so BullMQ skips the remaining attempts. Saves time +
// avoids 3x Slack failure noise on the same error.
//
// Transient errors (network, rate limit, socket timeout) still throw plain
// Error and retry with exponential backoff as before.
function classifyExecutionError(err: unknown): 'permanent' | 'transient' {
  const msg = String(err).toLowerCase()
  // Deterministic — won't change on retry
  if (msg.includes('framerpluginerror'))   return 'permanent'
  if (msg.includes('typia.createassert'))  return 'permanent'
  if (msg.includes('expect to be'))        return 'permanent'    // schema validation
  if (msg.includes('invalid type'))        return 'permanent'
  if (msg.includes('not found') && msg.includes('field')) return 'permanent'
  if (msg.includes('approval_id') && msg.includes('not exist'))  return 'permanent'
  if (msg.includes('confirmation hash')) return 'permanent'
  if (msg.includes('unique constraint')) return 'permanent'
  if (msg.includes('foreign key'))       return 'permanent'
  if (msg.includes('null value in column')) return 'permanent'
  // Transient — retry is plausibly useful
  if (msg.includes('econnreset'))        return 'transient'
  if (msg.includes('etimedout'))         return 'transient'
  if (msg.includes('rate limit'))        return 'transient'
  if (msg.includes('rate_limit'))        return 'transient'
  if (msg.includes('429'))               return 'transient'
  if (msg.includes('503'))               return 'transient'
  if (msg.includes('socket hang up'))    return 'transient'
  if (msg.includes('network'))           return 'transient'
  // Default: transient — let it retry, safer for unknowns
  return 'transient'
}
'''
    src = replace_one(
        src,
        "import { Worker, Job, UnrecoverableError } from 'bullmq'",
        "import { Worker, Job, UnrecoverableError } from 'bullmq'\n" + classifier_block,
        'worker.ts classifier injection',
    )
    # 2c. Change the failure throw to use the classifier
    src = replace_one(
        src,
        "    // Surface as throw so BullMQ records the failed attempt for its retry logic\n"
        "    throw new Error(`Execution failed: ${result.summary} (${result.error ?? 'no error detail'})`)",
        "    // Phase 9a: classify before throwing. Deterministic errors (schema,\n"
        "    // validation, FramerPluginError) throw UnrecoverableError so BullMQ\n"
        "    // doesn't waste 2 more retries on a known-broken call.\n"
        "    const errorMessage = `Execution failed: ${result.summary} (${result.error ?? 'no error detail'})`\n"
        "    const kind = classifyExecutionError(result.error ?? result.summary)\n"
        "    if (kind === 'permanent') {\n"
        "      logger.warn('execution_unrecoverable', { taskId, approvalId, toolName, summary: result.summary })\n"
        "      throw new UnrecoverableError(errorMessage)\n"
        "    }\n"
        "    throw new Error(errorMessage)",
        'worker.ts failure throw',
    )
    P.write_text(src)
    print('[2/5] execution worker — error classification + UnrecoverableError installed')

# ── 3. ITEM 4a: types.ts — add AdHocTightReport variant ────────────────────
P = ROOT / 'src/core/slack/blocks/types.ts'
src = must_read(P)
if 'AdHocTightReport' in src:
    print('[3/5] types.ts already has AdHocTightReport — skipping')
else:
    # Append the new interface AFTER AdHocCheckReport block, before the
    # FinalReport union.
    src = replace_one(
        src,
        "export type FinalReport = AdHocCheckReport | DailyRunReport | WeeklyAuditReport;",
        '''// ── Phase 9a: Tight ad-hoc response shape ───────────────────────────
//
// Used for Slack-mention runs that produce a single, focused output (e.g.
// "draft me a blog post"). Avoids the TL;DR/broken/working/leverage
// structure that makes sense for daily reports but reads as clinical
// overkill for a one-off task. The approval card carries the meaningful
// next action — the anchor just needs a short summary and a 'why'.
export interface AdHocTightReport {
  kind: 'ad_hoc_tight';
  tenantName: string;
  tenantSlug: string;
  runId: string;

  /** Short title for the run. e.g. "Drafted: Time zone objection post". */
  title: string;

  /** One sentence — what got done. Past tense, action-first. */
  summary: string;

  /** One sentence — why this matters for the business. */
  why: string;

  /** 0-2 optional context bullets. Most runs leave this empty. */
  notes?: string[];
}

export type FinalReport = AdHocCheckReport | AdHocTightReport | DailyRunReport | WeeklyAuditReport;''',
        'types.ts FinalReport union',
    )
    P.write_text(src)
    print('[3/5] types.ts — AdHocTightReport variant added')

# ── 4. ITEM 4b: new render file + anchor.ts switch ─────────────────────────
P_AHT = ROOT / 'src/core/slack/blocks/ad-hoc-tight.ts'
if P_AHT.exists() and 'renderAdHocTight' in P_AHT.read_text():
    print('[4a/5] ad-hoc-tight.ts already exists — skipping')
else:
    # We use chr(96) for backtick to avoid Python string escaping ambiguity.
    BT = chr(96)
    content = (
        "// src/core/slack/blocks/ad-hoc-tight.ts\n"
        "//\n"
        "// Renders the tight ad-hoc response — used for Slack-mention runs that\n"
        "// produce a single output. No TL;DR/broken/working/leverage scaffolding —\n"
        "// just title, summary, why, optional context notes, and footer. The\n"
        "// approval card (in the same thread) carries the meaningful next action.\n"
        "//\n"
        "// Compare to ad-hoc-check.ts (full structured report) — both render INLINE\n"
        "// in the anchor message when phase transitions to 'complete'.\n"
        "\n"
        "import type { KnownBlock } from '@slack/web-api'\n"
        "import {\n"
        "  header, section, divider, context, fallbackText, capBlocks, compact,\n"
        "} from './shared'\n"
        "import type { AdHocTightReport, RenderedMessage } from './types'\n"
        "\n"
        "export interface AdHocTightRenderContext {\n"
        "  elapsedLabel?: string\n"
        "  specialistCount?: number\n"
        "}\n"
        "\n"
        "export function renderAdHocTight(\n"
        "  report: AdHocTightReport,\n"
        "  ctx: AdHocTightRenderContext = {},\n"
        "): RenderedMessage {\n"
        f"  const headerLine = {BT}${{report.tenantName}} · ${{report.title}}{BT}\n"
        "  const notes = report.notes ?? []\n"
        "\n"
        "  const blocks = compact<KnownBlock>([\n"
        f"    header({BT}✅ ${{headerLine}}{BT}),\n"
        "    divider(),\n"
        f"    section({BT}${{report.summary}}\\n\\n_Why:_ ${{report.why}}{BT}),\n"
        "    notes.length > 0 && divider(),\n"
        f"    notes.length > 0 && section(notes.map(n => {BT}•  ${{n}}{BT}).join('\\n')),\n"
        "    divider(),\n"
        "    context([\n"
        f"      {BT}Run \\`${{report.runId.slice(0, 8)}}\\`{BT},\n"
        "      ctx.specialistCount != null\n"
        f"        ? {BT}${{ctx.specialistCount}} specialist${{ctx.specialistCount === 1 ? '' : 's'}}{BT}\n"
        "        : null,\n"
        "      ctx.elapsedLabel ?? null,\n"
        "    ].filter(Boolean) as string[]),\n"
        "  ])\n"
        "\n"
        "  return {\n"
        "    text: fallbackText({\n"
        "      title:   headerLine,\n"
        "      summary: report.summary,\n"
        "    }),\n"
        "    blocks: capBlocks(blocks),\n"
        "  }\n"
        "}\n"
    )
    P_AHT.write_text(content)
    print('[4a/5] ad-hoc-tight.ts — render function created')

# 4b. Wire into anchor.ts switch
P = ROOT / 'src/core/slack/blocks/anchor.ts'
src = must_read(P)
if "case 'ad_hoc_tight':" in src:
    print('[4b/5] anchor.ts already wires ad_hoc_tight — skipping')
else:
    src = replace_one(
        src,
        "import { renderAdHocCheck } from './ad-hoc-check';",
        "import { renderAdHocCheck } from './ad-hoc-check';\n"
        "import { renderAdHocTight } from './ad-hoc-tight';",
        'anchor.ts import',
    )
    src = replace_one(
        src,
        "    case 'ad_hoc':\n"
        "      return renderAdHocCheck(report, { elapsedLabel, specialistCount });",
        "    case 'ad_hoc':\n"
        "      return renderAdHocCheck(report, { elapsedLabel, specialistCount });\n"
        "    case 'ad_hoc_tight':\n"
        "      return renderAdHocTight(report, { elapsedLabel, specialistCount });",
        'anchor.ts switch',
    )
    P.write_text(src)
    print('[4b/5] anchor.ts — ad_hoc_tight case wired')

# Also re-export from blocks/index.ts so external callers can use renderAdHocTight
P_IDX = ROOT / 'src/core/slack/blocks/index.ts'
src_idx = must_read(P_IDX)
if 'renderAdHocTight' not in src_idx:
    src_idx = replace_one(
        src_idx,
        "export { renderAdHocCheck } from './ad-hoc-check';",
        "export { renderAdHocCheck } from './ad-hoc-check';\n"
        "export { renderAdHocTight } from './ad-hoc-tight';",
        'blocks/index.ts export',
    )
    P_IDX.write_text(src_idx)
    print('[4c/5] blocks/index.ts — renderAdHocTight re-exported')
else:
    print('[4c/5] blocks/index.ts already exports renderAdHocTight — skipping')

# ── 5. ITEM 4c: aggregator updates ─────────────────────────────────────────
P = ROOT / 'src/orchestrator/aggregator.ts'
src = must_read(P)
if 'ad_hoc_tight' in src:
    print('[5/5] aggregator.ts already produces ad_hoc_tight — skipping')
else:
    # 5a. expectedKindFor — Slack-mention and other non-cron triggers produce tight
    src = replace_one(
        src,
        "function expectedKindFor(trigger: TaskTrigger): FinalReport['kind'] {\n"
        "  switch (trigger) {\n"
        "    case 'cron-daily':  return 'daily'\n"
        "    case 'cron-weekly': return 'weekly'\n"
        "    default:            return 'ad_hoc'\n"
        "  }\n"
        "}",
        "function expectedKindFor(trigger: TaskTrigger): FinalReport['kind'] {\n"
        "  switch (trigger) {\n"
        "    case 'cron-daily':   return 'daily'\n"
        "    case 'cron-weekly':  return 'weekly'\n"
        "    // Phase 9a: ad-hoc Slack-mention runs default to the tight response\n"
        "    // shape — single-task runs that produced an approval card don't need\n"
        "    // the full TL;DR/broken/working/leverage structure.\n"
        "    default:             return 'ad_hoc_tight'\n"
        "  }\n"
        "}",
        'aggregator.ts expectedKindFor',
    )

    # 5b. enrichWithIdentity — handle the new variant
    src = replace_one(
        src,
        "  if (report.kind === 'ad_hoc') {\n"
        "    return { ...report, ...base }",
        "  if (report.kind === 'ad_hoc') {\n"
        "    return { ...report, ...base }\n"
        "  }\n"
        "  if (report.kind === 'ad_hoc_tight') {\n"
        "    return { ...report, ...base }",
        'aggregator.ts enrichWithIdentity',
    )

    # 5c. Replace validateMinimal entirely — the original requires .tldr on
    #     all reports, but AdHocTightReport doesn't have one. Cleanest fix:
    #     rewrite the function with explicit per-variant validation.
    src = replace_one(
        src,
        "function validateMinimal(report: FinalReport): boolean {\n"
        "  if (!report.tldr || !Array.isArray(report.tldr) || report.tldr.length === 0) return false\n"
        "\n"
        "  if (report.kind === 'ad_hoc') {\n"
        "    return Array.isArray(report.broken)\n"
        "        && Array.isArray(report.working)\n"
        "        && Array.isArray(report.leverage)\n"
        "        && typeof report.title === 'string'\n"
        "        && report.title.length > 0\n"
        "  }\n"
        "  if (report.kind === 'daily') {\n"
        "    return Array.isArray(report.shippedActions)\n"
        "        && Array.isArray(report.newOpportunities)\n"
        "        && Array.isArray(report.queuedForToday)\n"
        "        && Array.isArray(report.awaitingApproval)\n"
        "  }\n"
        "  // weekly\n"
        "  return Array.isArray(report.topPriorities)\n"
        "      && Array.isArray(report.clusterProgress)\n"
        "      && Array.isArray(report.riskFlags)\n"
        "      && Array.isArray(report.stateOfPlay)\n"
        "      && !!report.summary\n"
        "}",
        "function validateMinimal(report: FinalReport): boolean {\n"
        "  // Phase 9a: ad_hoc_tight doesn't have tldr — handle separately.\n"
        "  if (report.kind === 'ad_hoc_tight') {\n"
        "    return typeof report.title   === 'string' && report.title.length   > 0\n"
        "        && typeof report.summary === 'string' && report.summary.length > 0\n"
        "        && typeof report.why     === 'string' && report.why.length     > 0\n"
        "  }\n"
        "\n"
        "  if (!report.tldr || !Array.isArray(report.tldr) || report.tldr.length === 0) return false\n"
        "\n"
        "  if (report.kind === 'ad_hoc') {\n"
        "    return Array.isArray(report.broken)\n"
        "        && Array.isArray(report.working)\n"
        "        && Array.isArray(report.leverage)\n"
        "        && typeof report.title === 'string'\n"
        "        && report.title.length > 0\n"
        "  }\n"
        "  if (report.kind === 'daily') {\n"
        "    return Array.isArray(report.shippedActions)\n"
        "        && Array.isArray(report.newOpportunities)\n"
        "        && Array.isArray(report.queuedForToday)\n"
        "        && Array.isArray(report.awaitingApproval)\n"
        "  }\n"
        "  // weekly\n"
        "  return Array.isArray(report.topPriorities)\n"
        "      && Array.isArray(report.clusterProgress)\n"
        "      && Array.isArray(report.riskFlags)\n"
        "      && Array.isArray(report.stateOfPlay)\n"
        "      && !!report.summary\n"
        "}",
        'aggregator.ts validateMinimal',
    )

    # 5d. Replace buildAdHocSystem with one that produces the tight schema
    #     when the trigger is non-cron. The OLD buildAdHocSystem stays as
    #     buildAdHocFullSystem for any future caller that wants the full report.
    src = replace_one(
        src,
        "function buildAdHocSystem(tenant: TenantConfig): string {\n"
        "  return `You are the aggregator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.",
        "// Phase 9a: tight ad-hoc system prompt — for single-task Slack-mention\n"
        "// runs where the meaningful output is the approval card, not a report.\n"
        "function buildAdHocSystem(tenant: TenantConfig): string {\n"
        "  return `You are the aggregator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.\n\n"
        "You have just received the outputs of one or more specialists who worked on the operator's ad-hoc request. Most of the time this is a focused, single-task run (e.g. 'draft me a blog post') where the meaningful next step is already queued in the approval system. Your job is to produce a TIGHT summary, not a full report.\n\n"
        "# Who you're writing for\n\n"
        "${tenant.clientName}'s operator — they run the business. They asked for one thing; they want one tight answer plus the approval card already in the thread. Don't pad. Don't add a TL;DR if a single sentence covers it.\n\n"
        "Translate ALL technical concepts. NEVER use jargon. Common translations:\n"
        "- 'SERP' → 'search results'\n"
        "- 'CTR' → 'how often people click your listing'\n"
        "- 'meta description' → 'the summary under your title in search results'\n"
        "- 'meta title', 'title tag' → 'the headline in search results'\n"
        "- 'schema markup' → 'behind-the-scenes labels that help Google understand your page'\n"
        "- 'indexed' → 'showing up in Google'\n"
        "- 'backlinks' → 'links pointing to your site from other websites'\n\n"
        "# Output schema\n\n"
        "Output ONLY valid JSON matching this exact schema. No prose before or after. No markdown fences. No explanation. JSON only.\n\n"
        "{\n"
        '  \"kind\": \"ad_hoc_tight\",\n'
        '  \"title\": \"<4-8 words, action-first. e.g. \\\"Drafted: Time zone objection post\\\", \\\"Audit complete: 3 issues\\\", \\\"Topic queued for review\\\"\">,\n'
        '  \"summary\": \"<one sentence, past tense, action-first — what got done in this run. 15-30 words. No jargon.>\",\n'
        '  \"why\": \"<one sentence — why this matters for the business. 12-25 words. Outcome-focused.>\",\n'
        '  \"notes\": [\n'
        '    \"<optional 0-2 short context bullets — only when genuinely useful. e.g. \\\"Existing post on /agency-markups got 340 impressions last 28 days — adjacent topic\\\". MOST runs leave this empty.>\"\n'
        '  ]\n'
        "}\n\n"
        "# Voice and framing\n\n"
        "- First-person commitment, not directive. YES: \"I drafted a post on...\". NO: \"A post has been drafted...\".\n"
        "- Lead with the action, then the impact in the why line.\n"
        "- Plain prose. The Slack renderer handles emphasis.\n"
        "- Numbers and percentages where you have them — don't invent them.\n\n"
        "# Rules\n\n"
        "- title, summary, why are all MANDATORY.\n"
        "- notes is optional and usually empty. Only include when the operator would benefit from a concrete piece of context (a number, a comparison, a constraint).\n"
        "- NEVER produce broken/working/leverage fields. That schema is for cron daily/weekly reports, not ad-hoc.\n"
        "- If the specialist failed, set summary to a one-line failure description and why to a one-line on what the operator should do (file a bug, retry, etc.). Leave notes empty.\n"
        "`\n"
        "}\n\n"
        "function buildAdHocFullSystem(tenant: TenantConfig): string {\n"
        "  // Kept for legacy callers — produces the structured TL;DR/broken/working/leverage shape.\n"
        "  return `You are the aggregator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.",
        'aggregator.ts buildAdHocSystem split',
    )
    P.write_text(src)
    print('[5/5] aggregator.ts — tight ad-hoc prompt + variant routing installed')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push.')
