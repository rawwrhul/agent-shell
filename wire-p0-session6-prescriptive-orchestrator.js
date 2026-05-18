#!/usr/bin/env node
// wire-p0-session6-prescriptive-orchestrator.js  (v4 — auto-recovery)
//
// Rollout 9 Stage 1: prescriptive orchestrator.
//
// v4 changes vs v3:
//   - Auto-removes any existing "## Writing prescriptive..." section in the
//     file before re-inserting, regardless of whether the existing section
//     is the broken v2 raw-backtick version or a previously-correct one.
//     This makes the script robust against partial recoveries: no manual
//     git restore required.
//
// What this patch does:
//   1. Updates spawn_subagent's specific_task description.
//   2. Removes any pre-existing prescriptive-checklist section.
//   3. Inserts the correctly-escaped prescriptive-checklist section just
//      before "## Rules" in buildOrchestratorSystem.
//
// All backticks and ${ sequences in the injected content are escaped so
// they remain inside the outer TypeScript template literal.
//
// Idempotent: safe to re-run any number of times.

'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const ORCH = path.join(ROOT, 'src/orchestrator/index.ts')

if (!fs.existsSync(ORCH)) {
  console.error(`✗  missing: ${ORCH}`)
  process.exit(1)
}

let content = fs.readFileSync(ORCH, 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: update spawn_subagent specific_task description (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

const OLD_DESC = `          specific_task:   { type: 'string', description: 'The specific, scoped task for this specialist. Be precise — do not just repeat the original prompt.' },`

const NEW_DESC = `          specific_task:   { type: 'string', description: 'The CHECKLIST the specialist will execute. Use the CHECKLIST format from the system prompt: SCOPE line, numbered steps with explicit tool + token budget + stop criteria, STOP-after-step-N line, TOTAL BUDGET line. Plain paragraphs cause wandering and budget exhaustion — always use the checklist structure.' },`

if (content.includes(NEW_DESC)) {
  console.log(`⚠  spawn_subagent description already patched — skipping`)
} else {
  if (!content.includes(OLD_DESC)) {
    console.error('✗  spawn_subagent specific_task description not found in expected form')
    process.exit(1)
  }
  content = content.replace(OLD_DESC, NEW_DESC)
  console.log(`✅ patched spawn_subagent specific_task description`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: auto-recovery — remove any existing prescriptive-checklist section
// regardless of whether it's the broken v2 version or a prior correct version
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEADER = '## Writing prescriptive task checklists for each specialist'
const NEXT_HEADER    = '## Rules'

if (content.includes(SECTION_HEADER)) {
  const startIdx = content.indexOf(SECTION_HEADER)
  const endIdx   = content.indexOf(NEXT_HEADER, startIdx)
  if (endIdx === -1) {
    console.error('✗  found existing prescriptive section but cannot locate following "## Rules"')
    console.error('   file may be in an unexpected state — please run: git restore src/orchestrator/index.ts')
    process.exit(1)
  }
  const removed = content.slice(startIdx, endIdx)
  content = content.slice(0, startIdx) + content.slice(endIdx)
  console.log(`⚠  removed existing prescriptive section (${removed.length} chars) — will re-insert with correct escaping`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3: insert correctly-escaped prescriptive-checklist section before "## Rules"
// ─────────────────────────────────────────────────────────────────────────────

const RAW_SECTION_BODY = `## Writing prescriptive task checklists for each specialist

The \`specific_task\` field is the brief the specialist executes. Don't write it as a paragraph of guidance — write it as an EXPLICIT CHECKLIST the specialist follows step-by-step. This is the single biggest lever for run reliability. Specialists with vague paragraphs call 30-50 tools trying to figure out what to do, hit the 600k token cap, and the watchdog kills them at 12 minutes. Specialists with explicit checklists call exactly the tools listed, in order, and converge in 5-15 calls.

Template every specific_task MUST follow:

\`\`\`
SCOPE: <one-sentence goal in plain language>

CHECKLIST (execute in order, do not skip, do not insert extra steps):
1. <action verb + object> using <tool name>. Budget: <Nk tokens>. Stop when: <success criteria>.
2. <action verb + object> using <tool name>. Budget: <Nk tokens>. Stop when: <success criteria>.
... (3-7 steps total — more than 7 = split into multiple specialist spawns)

STOP after step N. Do not:
- File additional propose_action calls beyond what the checklist specifies
- Run extra discovery tools after reaching step N
- Draft alternative versions of the same change

TOTAL BUDGET: <Mk tokens>. Quick scope: 5-15k. Diagnostic: 15-30k. Audit: 30-80k.
\`\`\`

### Example checklists for the executors shipped in P0 sessions 1-5

**Blog meta gap fix (quick scope, ~8k):**

\`\`\`
SCOPE: Find one blog post with the weakest meta and propose a single fix.

CHECKLIST:
1. Call framer_list_blog_items. Budget: 2k. Stop when: array returned.
2. Identify the post with the weakest title (length out of 30-60 chars, OR missing the target keyword based on ranking_history). Budget: 2k. Stop when: one slug picked.
3. Draft improved title (50-60 chars, target keyword in first half) and meta description (140-160 chars, lead with value prop). Budget: 3k. Stop when: both drafted.
4. File propose_action with toolName='framer_update_blog_meta', toolInput={ slug, newTitle, newDescription }, riskLevel='medium'. Budget: 500. Stop when: approval_id returned.

STOP after step 4. Do not file additional propose_actions. Do not draft alternative versions.

TOTAL BUDGET: 8k.
\`\`\`

**Body refresh on underperforming post (diagnostic scope, ~30k):**

\`\`\`
SCOPE: Refresh one underperforming blog post body to improve its ranking.

CHECKLIST:
1. Call framer_list_blog_items. Budget: 2k. Stop when: list returned.
2. Cross-ref with ranking_history; pick one post ranking position 11-30 ("almost there" zone). Budget: 3k. Stop when: one slug picked.
3. web_fetch the current body for that post. Budget: 3k. Stop when: HTML retrieved.
4. Call dataforseo_serp_overview for the target keyword; identify top 3 competitor angles. Budget: 5k. Stop when: 3 angles identified.
5. Draft refreshed HTML body adding 1-2 sections that address competitor gaps. Budget: 15k. Stop when: full new HTML written.
6. File propose_action with toolName='framer_update_blog_body', toolInput={ slug, newContent }, riskLevel='high'. Budget: 500. Stop when: approval_id returned.

STOP after step 6. Do not refresh multiple posts in one run.

TOTAL BUDGET: 30k.
\`\`\`

**New blog post pitch (diagnostic scope, ~25k):**

\`\`\`
SCOPE: Identify one high-value topic gap and file a blog pitch.

CHECKLIST:
1. Call dataforseo_keyword_ideas with seed=<tenant's primary domain>. Budget: 5k. Stop when: top 20 keywords returned.
2. Filter to keywords with KD <30 AND volume >100 AND commercial intent. Budget: 2k. Stop when: shortlist of 3-5.
3. Pick the best by intersection of volume × intent × clusters not yet owned. Budget: 2k. Stop when: one keyword picked.
4. Draft post title, slug, full HTML body (800-1500 words in formattedText), and hero imageUrl. Budget: 15k. Stop when: complete draft written.
5. File propose_action with toolName='approve_blog_pitch', toolInput={ slug, title, content, imageUrl, whyThisTopic }, riskLevel='high'. Budget: 500. Stop when: approval_id returned.

STOP after step 5. Do not draft a second post (token budget will not support it).

TOTAL BUDGET: 25k.
\`\`\`

**Marketing page text update (quick scope, ~12k):**

\`\`\`
SCOPE: Identify one specific text on About/Contact/Resources and propose a one-line improvement.

CHECKLIST:
1. web_fetch https://<tenant_site>/<page>. Budget: 3k. Stop when: HTML retrieved.
2. Identify ONE specific text string (headline, subhead, CTA) that's weak or off-message. Budget: 3k. Stop when: exact string identified, copied verbatim.
3. Draft improved version (preserve intent, stronger language, no jargon). Budget: 3k. Stop when: new string drafted.
4. File propose_action with toolName='framer_update_marketing_page_text', toolInput={ pagePath, oldText, newText }, riskLevel='high'. Budget: 500. Stop when: approval_id returned.

STOP after step 4. Do not propose multiple text changes in one run.

TOTAL BUDGET: 12k.
\`\`\`

**Backlink prospect surfacing from the bank (quick scope, ~6k):**

\`\`\`
SCOPE: Surface 2-3 highest-quality backlink prospects from the bank — no new discovery.

CHECKLIST:
1. Query seo_opportunities WHERE type='backlink_prospect' AND status='unsurfaced' ORDER BY priority. Budget: 1k. Stop when: top 5 returned.
2. For each, verify the prospect_domain is still live via web_fetch (HEAD). Budget: 2k. Stop when: 2-3 verified live.
3. log_opportunity with a draft outreach pitch for each verified prospect (use backlink_template). Budget: 2k. Stop when: 2-3 pitches drafted.

STOP after step 3. Do not run new backlink discovery — that's the backlink_analysis cron's job.

TOTAL BUDGET: 6k.
\`\`\`

### Critical principles

**Use the opportunity bank first.** For all daily/weekly cron-triggered runs, background crons populate seo_opportunities with discovered opportunities. The daily run should DRAFT from those entries, not re-discover them. If the bank has unsurfaced entries of the right type, the checklist should query the bank as step 1 instead of running discovery tools. This is the difference between 25k token runs (draft from bank) and 200k token runs (rediscover everything).

**Pick ONE thing per specialist spawn.** Don't write a checklist that says "find the 5 worst meta gaps and fix all of them" — that explodes into a 100k token wander. One specialist spawn = one concrete outcome (one propose_action filed, or one opportunity logged). For multi-action runs, spawn multiple specialists in parallel, each with its own focused checklist.

**Be tool-explicit.** Every step names the specific tool. "Analyze the homepage" is wrong (specialist will reach for 5 different tools). "Call framer_get_publish_info, then web_fetch the homepage, then read the page in 4 sections" is right.

**Budget every step.** Token budgets per step force the specialist to be efficient. A step with budget=2k means: stop after one tool call + small reasoning. A step with budget=15k means: ok to draft a full article body. If a step has no budget, the specialist will expand to fill all available context.

`

function escapeForTemplateLiteral(s) {
  return s
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
}

const ESCAPED_SECTION = escapeForTemplateLiteral(RAW_SECTION_BODY)

const RULES_ANCHOR = `## Rules
- Spawn ONLY the specialists actually needed for the request. A targeted request may need just one. A full audit needs all.`

if (!content.includes(RULES_ANCHOR)) {
  console.error('✗  could not find "## Rules" + first bullet anchor — orchestrator file structure may have changed')
  console.error('   please run: git restore src/orchestrator/index.ts  and try again')
  process.exit(1)
}

const occurrences = content.split(RULES_ANCHOR).length - 1
if (occurrences !== 1) {
  console.error(`✗  expected exactly 1 occurrence of "## Rules" anchor, found ${occurrences}`)
  process.exit(1)
}

content = content.replace(RULES_ANCHOR, ESCAPED_SECTION + RULES_ANCHOR)
console.log(`✅ inserted prescriptive-orchestration section before ## Rules`)

// ─────────────────────────────────────────────────────────────────────────────
// Write and sanity-check
// ─────────────────────────────────────────────────────────────────────────────

fs.writeFileSync(ORCH, content, 'utf8')

// Sanity-check 1: the escaped section in the file should NOT contain raw
// backticks (every backtick should be preceded by a backslash). Count raw
// backticks inside our injected section and assert == 0.
const written = fs.readFileSync(ORCH, 'utf8')
const sectionStart = written.indexOf(SECTION_HEADER)
const sectionEnd   = written.indexOf(NEXT_HEADER, sectionStart)
const writtenSection = written.slice(sectionStart, sectionEnd)

let rawBacktickCount = 0
for (let i = 0; i < writtenSection.length; i++) {
  if (writtenSection[i] === '`') {
    const prev = i > 0 ? writtenSection[i - 1] : ''
    if (prev !== '\\') {
      rawBacktickCount++
    }
  }
}

if (rawBacktickCount > 0) {
  console.error(`✗  SANITY CHECK FAILED: ${rawBacktickCount} unescaped backticks remain in the injected section`)
  console.error('   this would break the TypeScript template literal — reverting')
  console.error('   please run: git restore src/orchestrator/index.ts')
  process.exit(1)
}

console.log(`✅ sanity check passed: 0 unescaped backticks in injected section`)
console.log('')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('Session 6 wire-up complete: prescriptive orchestrator (Rollout 9 Stage 1)')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('')
console.log('1. Verify TypeScript:  npx tsc --noEmit')
console.log('')
console.log('2. Deploy:')
console.log('   git add -A && git commit -m "feat: prescriptive orchestrator with checklist format (Rollout 9 Stage 1)"')
console.log('   git push origin main')
console.log('')
console.log('3. After deploy, trigger an on-demand run and verify in Supabase SQL editor:')
console.log('   SELECT specialist_type, LEFT(task, 300) AS task_preview')
console.log('     FROM subtasks')
console.log('     WHERE parent_task_id = (')
console.log('       SELECT id FROM run_records ORDER BY started_at DESC LIMIT 1')
console.log('     );')
console.log('   Each row should start with "SCOPE: ... CHECKLIST: 1. ... 2. ... STOP after step N. TOTAL BUDGET: Xk."')
