#!/usr/bin/env python3
"""
phase8_5-patch.py — Three polish items on top of Phase 8.

Run from project root. Idempotent.

  1. Remove Task Executor thread-reply noise (anchor still re-renders with summary)
  2. Research-first blog workflow in subagent prompt (GSC + DataForSEO + memory FIRST,
     then topic selection, then drafting)
  3. Wall-clock + token-budget enforcement per specialist run

Apply, run npx tsc --noEmit, then commit + push.
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

# ── 1. presenter.ts — silence the Task Executor thread reply ────────────────
P = ROOT / 'src/core/slack/presenter.ts'
src = must_read(P)
if '// Phase 8.5: specialist completion thread post suppressed' in src:
    print('[1/3] presenter.ts already suppresses specialist thread post — skipping')
else:
    src = replace_one(
        src,
        "    if (!row) return;\n"
        "    const entry = row.state.specialists[type];\n"
        "    if (entry) {\n"
        "      await this.postThread(row.tenantId, row.channelId, row.anchorTs,\n"
        "        renderSpecialistComplete(entry));\n"
        "    }\n"
        "  }\n\n"
        "  async recordSpecialistFailure(",
        "    if (!row) return;\n"
        "    // Phase 8.5: specialist completion thread post suppressed.\n"
        "    // The state mutation above already updates the anchor message's\n"
        "    // summary, so the operator sees the completion in the anchor's\n"
        "    // TL;DR. The thread-level Task Executor reply was duplicative\n"
        "    // technical noise — Approve/Reject cards belong in the thread,\n"
        "    // not bot status echoes.\n"
        "    void renderSpecialistComplete;  // silence unused-import lint\n"
        "  }\n\n"
        "  async recordSpecialistFailure(",
        'presenter.ts recordSpecialistComplete tail',
    )
    P.write_text(src)
    print('[1/3] presenter.ts — Task Executor thread post suppressed')

# ── 2. subagent.ts — research-first blog workflow ───────────────────────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
if 'BEFORE proposing anything, ground the topic in TARINO' in src or 'BEFORE proposing anything, ground the topic in' in src:
    print('[2/3] subagent.ts already has research-first workflow — skipping')
else:
    # Phase 8 patch wrote literal backslash-apostrophe sequences into the file
    # (escaping bug). Clean those up first so the prompt is readable AND so
    # our anchors below match. Replace \' with just '.
    src = src.replace("\\'", "'")
    P.write_text(src)
    src = must_read(P)

    old_section = '''## On Framer blog posts (two-stage approval, Phase 8)

Two operator-facing gates: PITCH (you propose; operator says is-this-worth-writing?) then PUBLISH (operator reviews the actual draft in Framer; says ship-it?). Both are propose_action calls — you only ever file one card per post. The second card is created by the executor on the operator's first approval.

To propose a new blog post:

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes.

2. Call framer_list_blog_items. Two purposes:
   (a) Confirm your proposed slug is unique.
   (b) Pick 2-3 of the most recent posts and study them — they ARE the voice you write in. Mirror cadence, paragraph length, register, and structure. The tone is the operator's real voice; do not invent your own.

3. Write the post in full — title + slug + content. Content is HTML in Framer's formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.

4. Inside the body, embed 2-4 internal links to other Tarino posts where the cross-reference is genuinely useful (not gratuitous). Format: <a href="/resources/SLUG">descriptive anchor text</a> — use slugs from framer_list_blog_items. Anchor text should be a real noun phrase from the sentence.

5. Call pexels_search with a 2-4 word CONCRETE-NOUN query that reflects the post subject — "australian small business owner laptop", "calculator paperwork desk", "warehouse logistics team". Avoid abstract phrases. Pick the most editorially-relevant result. Use the "url_for_post" field — that's the landscape-cropped URL.

6. File propose_action ONCE with:
     toolName       = "approve_blog_pitch"
     toolInput      = { slug, title, content, imageUrl, whyThisTopic }
     proposedAction = one-line plain-English pitch summary for the operator (this is what they read first)
     priority       = P0 / P1 / P2 / P3
     previewUrl     = the post-publish URL the operator can visit AFTER both approvals (https://tarino.au/resources/ followed by the slug). It will 404 until Stage 2 approve.

What happens after:
   - On Stage 1 approve (operator likes the pitch): executor creates the CMS draft in Framer (Title, Date, Content, Image fields filled), then posts a Stage 2 card in the same thread. The Stage 2 card links to Framer where the operator can review the actual rendered draft. Approving Stage 2 publishes to tarino.au.
   - On Stage 1 reject: nothing is created in Framer. No cleanup needed.
   - On Stage 2 reject: the draft is removed from Framer (rollback).

Critical: do NOT call framer_draft_blog_post yourself. Do NOT use toolName 'framer_create_and_publish_blog_post' (deprecated single-stage path). The draft creation happens server-side after Stage 1 approval — you only file the pitch.

For non-blog work — schema markup, internal linking inside EXISTING posts, copy edits on live pages, meta tag updates, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer's editor without further input from you.'''

    new_section = '''## On Framer blog posts (research-first, two-stage approval)

Two operator-facing gates: PITCH (you propose; operator says is-this-worth-writing?) then PUBLISH (operator reviews the actual draft in Framer; says ship-it?). Both are propose_action calls — you only ever file one card per post. The second card is created by the executor on the operator's first approval.

CRITICAL: BEFORE proposing anything, ground the topic in TARINO'S actual performance data. A "content gap" is not an opportunity by itself — a topic that has search demand AND fits Tarino's commercial model AND is adjacent to content that's already working IS. Skipping the grounding step produces off-brand topics that waste the operator's time.

Workflow:

### Phase A — Ground in Tarino's actual performance

A.1  Call query_memory with type='learning' early. Look for retro-* keys — past runs have written findings about what kinds of work moved the needle for this tenant. Use these as priors.

A.2  Call gsc_query_search_analytics with last 28 days, dimensions=['page', 'query'], rowLimit=200. Identify:
     - The top 5 pages by clicks (what content is already winning)
     - Top 20 queries by impressions where position is 4-15 (rankings within striking distance to improve)
     - Themes across high-impression queries (what topics is the audience actually searching for)

A.3  Call framer_list_blog_items. Read the titles + dates. Map each one onto a theme: which topics on the site already have proven traction (from A.2), which were written but didn't pull traffic, what's the editorial range.

A.4  Form a hypothesis: what topic, IF added to the site, would (a) build on a proven theme from A.2 rather than start a new one, (b) match the existing site's evident commercial lane (look at what existing posts SELL — who would click an outbound CTA?), and (c) target a query cluster with real intent.

A.5  Validate the hypothesis with dataforseo_keyword_data on 3-5 candidate queries around your topic. You're looking for: AU search volume ≥ 50/month, CPC ≥ $2 (signals commercial intent), keyword difficulty ≤ 60. If your candidate fails all three, pick a different angle.

If A.1–A.5 produces no candidate that passes, STOP and surface the situation to the operator rather than picking a weak topic. A blog post written for nobody is worse than no post.

### Phase B — Write the post (only after A passes)

B.1  Call framer_get_changed_paths. If pending changes exist, STOP — surface to operator. Publishing would bundle them.

B.2  Re-read the 2-3 highest-traffic posts from A.2. They ARE the voice and structure you mirror. Cadence, paragraph length, register, how subheads work, whether posts close with a CTA or a thought. Do not invent a new tone.

B.3  Write the post in full — title + slug + content. Content is HTML in Framer's formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>. Headline should map to the validated query cluster from A.5.

B.4  Embed 2-4 internal links to other Tarino posts where the cross-reference is genuinely useful (not gratuitous). Format: <a href="/resources/SLUG">descriptive anchor text</a> — anchor text is a real noun phrase from the sentence. Prefer linking to the existing high-traffic posts from A.2 (they're already ranking; pass authority).

B.5  Call pexels_search with a 2-4 word CONCRETE-NOUN query that reflects the post subject — "australian small business owner laptop", "calculator paperwork desk", "warehouse logistics team". Avoid abstract phrases. Pick the most editorially-relevant result. Use the "url_for_post" field — landscape-cropped URL ready for Framer.

### Phase C — File the pitch

C.1  File propose_action ONCE with:
     toolName       = "approve_blog_pitch"
     toolInput      = { slug, title, content, imageUrl, whyThisTopic }
     proposedAction = one-line plain-English pitch summary for the operator
     priority       = P0 / P1 / P2 / P3
     previewUrl     = https://tarino.au/resources/<slug> (will 404 until Stage 2 approve)
     whyPriority    = grounding from Phase A — cite the GSC signal (e.g. "/<existing-page> ranks position 8 for [query] with 1,200 monthly impressions; this new post targets the upstream intent")

C.2  What happens after:
     - Stage 1 approve: executor creates Framer draft + posts Stage 2 card in the same thread.
     - Stage 1 reject: nothing created. No cleanup.
     - Stage 2 approve: publishes live to tarino.au. Operator reviews the rendered draft in Framer between Stage 1 and Stage 2.
     - Stage 2 reject: rollback removes the draft.

Critical: do NOT call framer_draft_blog_post yourself. Do NOT use toolName 'framer_create_and_publish_blog_post' (deprecated). The draft creation happens server-side after Stage 1 approve — you only file the pitch.

For non-blog work — schema markup, internal linking inside EXISTING posts, copy edits on live pages, meta tag updates, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer's editor without further input from you.'''

    if old_section in src:
        src = src.replace(old_section, new_section)
        P.write_text(src)
        print('[2/3] subagent.ts — research-first workflow installed')
    else:
        sys.exit('[2/3] could not find Phase 8 section to replace; aborting')

# ── 3. subagent.ts — wall-clock + token-budget enforcement in loop ──────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
if 'MAX_SPECIALIST_DURATION_MS' in src:
    print('[3/3] subagent.ts already has budget enforcement — skipping')
else:
    # Add the constants near the existing per-call timeout
    src = replace_one(
        src,
        "const PER_CALL_TIMEOUT_MS = 90_000",
        "const PER_CALL_TIMEOUT_MS = 90_000\n\n"
        "// Phase 8.5: wall-clock + token enforcement per specialist run.\n"
        "// Caps both runaway loops and unbounded research. Tenant.tokenBudgetPerRun\n"
        "// is the soft ceiling per specialist; if it overruns we break out with a\n"
        "// graceful summary rather than letting the loop continue burning credits.\n"
        "const MAX_SPECIALIST_DURATION_MS = 8 * 60 * 1000   // 8 minutes hard ceiling",
        'subagent.ts MAX constants',
    )
    # Inject budget-check at the top of the main `while (turns < iterationCap)` loop.
    # We anchor on the existing `while` line and inject before it / inside it.
    src = replace_one(
        src,
        "  try {\n"
        "    let turns = 0\n"
        "    while (turns < iterationCap) {\n"
        "      turns++",
        "  try {\n"
        "    const startedAt = Date.now()\n"
        "    let turns = 0\n"
        "    let budgetExhausted: string | null = null\n"
        "    while (turns < iterationCap) {\n"
        "      turns++\n\n"
        "      // Phase 8.5: wall-clock check (before API call so we don't burn one)\n"
        "      const elapsedMs = Date.now() - startedAt\n"
        "      if (elapsedMs > MAX_SPECIALIST_DURATION_MS) {\n"
        "        budgetExhausted = `wall-clock ${Math.round(elapsedMs / 1000)}s exceeded cap ${MAX_SPECIALIST_DURATION_MS / 1000}s`\n"
        "        logger.warn('subagent_budget_wall_clock', { taskId: task.id, subTaskId, elapsedMs, turns })\n"
        "        break\n"
        "      }\n"
        "      // Phase 8.5: token-budget check (tenant-configured ceiling)\n"
        "      if (tenant.tokenBudgetPerRun && tokenCount >= tenant.tokenBudgetPerRun) {\n"
        "        budgetExhausted = `token budget ${tokenCount}/${tenant.tokenBudgetPerRun} exceeded`\n"
        "        logger.warn('subagent_budget_tokens', { taskId: task.id, subTaskId, tokenCount, budget: tenant.tokenBudgetPerRun, turns })\n"
        "        break\n"
        "      }",
        'subagent.ts loop top — budget checks',
    )
    # On exit from loop (when budget exhausted), produce a graceful final summary
    # if we don't have one. We anchor on the existing post-loop block.
    # We find the `} finally {` clause and check what happens between the loop end
    # and the finally — if finalOutput is empty but budgetExhausted is set, we
    # synthesise a short message.
    src = replace_one(
        src,
        "    while (turns < iterationCap) {",
        "    while (turns < iterationCap) {",
        'subagent.ts sanity check',
    )
    # Actually inject the graceful exit AFTER the while loop. Look for the
    # block that runs immediately after the loop.
    src = replace_one(
        src,
        "    if (turns >= iterationCap && !finalOutput) {\n"
        "      logger.warn('subagent_iteration_cap_hit', {",
        "    if (budgetExhausted && !finalOutput) {\n"
        "      finalOutput = `Run stopped early — ${budgetExhausted}. Partial work may be in run_scratchpad / approval_requests for review. No further proposals filed in this run.`\n"
        "      logger.info('subagent_budget_stop_synthesised', { taskId: task.id, subTaskId, reason: budgetExhausted })\n"
        "    }\n\n"
        "    if (turns >= iterationCap && !finalOutput) {\n"
        "      logger.warn('subagent_iteration_cap_hit', {",
        'subagent.ts post-loop graceful synth',
    )
    P.write_text(src)
    print('[3/3] subagent.ts — wall-clock + token-budget enforcement installed')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push.')
