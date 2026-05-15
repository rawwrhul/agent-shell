#!/usr/bin/env python3
"""
phase8-patch.py — Two-stage approval flow (pitch → draft-review → publish)
                  + threaded Slack approval cards
                  + URL path fix (/blog/ → /resources/)

This patch supersedes the atomic create-and-publish design from Phase 6.

Run from project root. Idempotent.

Sections:
  1. NEW   sql/20260515-phase8-two-stage-approval.sql   parent_approval_id column
  2. NEW   db/migrations/phase8-two-stage-approval.ts   migration runner
  3. EDIT  db/migrate.ts                                wire the migration
  4. EDIT  src/hitl/state-store.ts                      createApproval accepts parentApprovalId
  5. EDIT  src/integrations/framer/executor.ts         + execApproveBlogPitch executor
  6. EDIT  src/execution/dispatcher.ts                  register approve_blog_pitch
  7. EDIT  src/core/slack/presenter.ts                  thread requestApproval + approvalResolved
  8. EDIT  src/core/slack/render.ts                     inferActionKind: approve_blog_pitch → publish_content
  9. EDIT  src/skills/seo/tools.ts                      rewrite propose_action description, fix URLs
 10. EDIT  src/agents/subagent.ts                       new one-step pitch workflow, fix URLs
 11. EDIT  src/integrations/framer/tools.ts            URL fix in tool description
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path.cwd()
assert (ROOT / 'package.json').exists() and (ROOT / 'src').exists(), 'Run from project root.'

def must_read(p: Path) -> str:
    if not p.exists(): sys.exit(f'fatal: file missing: {p}')
    return p.read_text()

def replace_one(text: str, anchor: str, new: str, where: str) -> str:
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:400]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── 1. NEW SQL MIGRATION ────────────────────────────────────────────────────
P = ROOT / 'sql/20260515-phase8-two-stage-approval.sql'
if P.exists():
    print('[1/11] sql/20260515-phase8-two-stage-approval.sql already exists — skipping')
else:
    P.write_text('''-- 20260515-phase8-two-stage-approval.sql
--
-- Two-stage approval flow: Stage 1 (approve_blog_pitch) creates a draft in
-- Framer + queues Stage 2 (framer_confirm_publish). Stage 2 row links back
-- to Stage 1 via parent_approval_id so the chain is traceable.
--
-- Also enables thread-replies for approval cards (no schema change required;
-- presenter looks up the anchor_ts from slack_runs by task_id).

BEGIN;

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS parent_approval_id UUID REFERENCES approval_requests(id);

CREATE INDEX IF NOT EXISTS idx_approval_parent ON approval_requests (parent_approval_id)
  WHERE parent_approval_id IS NOT NULL;

COMMIT;
''')
    print('[1/11] sql/20260515-phase8-two-stage-approval.sql — created')

# ── 2. NEW MIGRATION RUNNER ─────────────────────────────────────────────────
P = ROOT / 'db/migrations/phase8-two-stage-approval.ts'
if P.exists():
    print('[2/11] db/migrations/phase8-two-stage-approval.ts already exists — skipping')
else:
    P.write_text('''// db/migrations/phase8-two-stage-approval.ts
//
// Adds approval_requests.parent_approval_id for the two-stage approval flow.
// Idempotent — safe to re-run.

import type { Pool } from 'pg'

export async function runPhase8Migration(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE approval_requests
      ADD COLUMN IF NOT EXISTS parent_approval_id UUID REFERENCES approval_requests(id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_approval_parent
      ON approval_requests (parent_approval_id)
      WHERE parent_approval_id IS NOT NULL
  `)
}
''')
    print('[2/11] db/migrations/phase8-two-stage-approval.ts — created')

# ── 3. WIRE MIGRATION INTO migrate.ts ───────────────────────────────────────
P = ROOT / 'db/migrate.ts'
src = must_read(P)
if 'runPhase8Migration' in src:
    print('[3/11] db/migrate.ts already wires phase8 — skipping')
else:
    src = replace_one(
        src,
        "import { runR3Migration } from './migrations/r3-tenant-schedules-and-domain'",
        "import { runR3Migration } from './migrations/r3-tenant-schedules-and-domain'\n"
        "import { runPhase8Migration } from './migrations/phase8-two-stage-approval'",
        'db/migrate.ts imports',
    )
    src = replace_one(
        src,
        "  await runR3Migration(pool)\n\n  console.log('✅ All migrations complete')",
        "  await runR3Migration(pool)\n  await runPhase8Migration(pool)\n\n  console.log('✅ All migrations complete')",
        'db/migrate.ts runner call',
    )
    P.write_text(src)
    print('[3/11] db/migrate.ts — wired phase8 migration')

# ── 4. state-store.ts — createApproval accepts parentApprovalId ─────────────
P = ROOT / 'src/hitl/state-store.ts'
src = must_read(P)
if 'parentApprovalId' in src:
    print('[4/11] state-store.ts already supports parentApprovalId — skipping')
else:
    # Find the previewUrl line in CreateApprovalInput and append parentApprovalId
    src = replace_one(
        src,
        "  previewUrl?:      string;\n}",
        "  previewUrl?:      string;\n\n"
        "  /** Phase 8 (15 May 2026): for two-stage flow, Stage 2 rows link back\n"
        "   *  to Stage 1 via parent_approval_id so the chain is traceable. */\n"
        "  parentApprovalId?: string;\n"
        "}",
        'state-store CreateApprovalInput',
    )
    # Update the INSERT to include parent_approval_id
    src = replace_one(
        src,
        "    `INSERT INTO approval_requests (\n"
        "       tenant_id, task_id, session_id, tool_name, tool_input,\n"
        "       risk_level, risk_reason, priority, proposed_action, detail,\n"
        "       why_priority, slack_channel_id, slack_message_ts, sheet_row_number,\n"
        "       preview_url\n"
        "     ) VALUES (\n"
        "       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15\n"
        "     )\n"
        "     RETURNING ${SELECT_COLS}`,",
        "    `INSERT INTO approval_requests (\n"
        "       tenant_id, task_id, session_id, tool_name, tool_input,\n"
        "       risk_level, risk_reason, priority, proposed_action, detail,\n"
        "       why_priority, slack_channel_id, slack_message_ts, sheet_row_number,\n"
        "       preview_url, parent_approval_id\n"
        "     ) VALUES (\n"
        "       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16\n"
        "     )\n"
        "     RETURNING ${SELECT_COLS}`,",
        'state-store INSERT statement',
    )
    src = replace_one(
        src,
        "      input.previewUrl ?? null,\n"
        "    ],\n"
        "  );",
        "      input.previewUrl ?? null,\n"
        "      input.parentApprovalId ?? null,\n"
        "    ],\n"
        "  );",
        'state-store INSERT params array',
    )
    P.write_text(src)
    print('[4/11] state-store.ts — createApproval now accepts parentApprovalId')

# ── 5. framer/executor.ts — add execApproveBlogPitch ────────────────────────
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)
if 'execApproveBlogPitch' in src:
    print('[5/11] framer/executor.ts already has execApproveBlogPitch — skipping')
else:
    # Append the new executor at the end of the file (after any existing exports)
    appendix = '''

// ── Phase 8: execApproveBlogPitch ───────────────────────────────────────────
//
// Stage 1 of the two-stage approval flow. Fires when operator approves a
// `approve_blog_pitch` proposal in Slack. Side effects:
//   1) Creates the Framer CMS draft via draftAndPreviewBlogPost (writes the
//      Title, Date, Content, and Image fields; gets a confirmationHash).
//   2) Inserts a Stage 2 approval row with tool_name='framer_confirm_publish',
//      parent_approval_id pointing back at this Stage 1 row. The hitl
//      worker's standard Slack-card path picks this up and posts the
//      Stage 2 card automatically.
//   3) Returns success — the executor framework writes execution_jobs.result
//      with the new approvalId so the operator can trace the chain.
//
// On any failure: surfaces the error via the standard ExecutionResult.error
// channel. The Stage 1 approval row is marked execution_error by the
// framework, and the operator sees the failure in Slack.

import { createApproval } from '../../hitl/state-store'
import { pool } from '../../memory/postgres'

export interface ApproveBlogPitchInput {
  slug:        string
  title:       string
  content:     string             // HTML in Framer formattedText format
  imageUrl?:   string
  whyThisTopic?: string
}

export async function execApproveBlogPitch(
  input: ApproveBlogPitchInput, ctx: IntegrationContext,
): Promise<ExecutionResult> {
  if (!input.slug || !input.title || !input.content) {
    return { ok: false, summary: 'approve_blog_pitch error: slug, title, content all required',
             error: 'missing required field in toolInput' }
  }
  try {
    // 1. Create the Framer draft (writes CMS item, gets confirmationHash)
    const draft = await fr.draftAndPreviewBlogPost(ctx.tenant, {
      slug:     input.slug,
      title:    input.title,
      content:  input.content,
      imageUrl: input.imageUrl,
    })

    // 2. File the Stage 2 approval (framer_confirm_publish), linked to Stage 1
    const stage1ApprovalId = ctx.approvalId
    if (!stage1ApprovalId) {
      return { ok: false, summary: 'approve_blog_pitch error: missing Stage 1 approvalId in context',
               error: 'ctx.approvalId is undefined; cannot link Stage 2 back' }
    }

    const projectUrl = ctx.tenant.framer_project_url ?? ''
    const stage2 = await createApproval(pool, {
      tenantId:        ctx.tenant.tenantId,
      taskId:          ctx.taskId,
      toolName:        'framer_confirm_publish',
      toolInput:       {
        confirmationHash: draft.preview.confirmationHash,
        itemId:           draft.itemId,
        slug:             input.slug,
        title:            input.title,
      } as Record<string, unknown>,
      riskLevel:       'high',
      riskReason:      'Will publish the drafted post live to tarino.au.',
      priority:        'P1',
      proposedAction:  `Publish '${input.title}' to /resources/${input.slug}`,
      whyPriority:     input.whyThisTopic ?? 'Draft ready for review in Framer.',
      slackChannelId:  null as unknown as string | undefined,  // presenter looks up from slack_runs
      previewUrl:      projectUrl,                             // links to Framer project for draft review
      parentApprovalId: stage1ApprovalId,
    })

    return {
      ok:      true,
      summary: `Draft created in Framer. Stage 2 approval posted (id ${stage2.id.slice(0, 8)}).`,
      detail: {
        itemId:           draft.itemId,
        slug:             input.slug,
        confirmationHash: draft.preview.confirmationHash,
        stage2ApprovalId: stage2.id,
        framerProjectUrl: projectUrl,
        productionUrl:    `https://tarino.au/resources/${input.slug}`,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: `approve_blog_pitch failed: ${String(err).slice(0, 160)}`,
      error:   String(err).slice(0, 400),
    }
  }
}
'''
    src += appendix
    P.write_text(src)
    print('[5/11] framer/executor.ts — added execApproveBlogPitch')

# ── 6. dispatcher.ts — register approve_blog_pitch ──────────────────────────
P = ROOT / 'src/execution/dispatcher.ts'
src = must_read(P)
if 'approve_blog_pitch' in src:
    print('[6/11] dispatcher.ts already registers approve_blog_pitch — skipping')
else:
    # Find the executor import block and add execApproveBlogPitch
    src = replace_one(
        src,
        "  execFramerCreateAndPublishBlogPost,\n  execManualOperatorTask,\n} from '../integrations/framer/executor'",
        "  execFramerCreateAndPublishBlogPost,\n  execManualOperatorTask,\n  execApproveBlogPitch,\n} from '../integrations/framer/executor'",
        'dispatcher.ts executor import',
    )
    # Find the HANDLERS map and add the new entry (anchor on the GSC line above)
    src = replace_one(
        src,
        "  // GSC\n"
        "  'gsc_submit_sitemap':        (i, c) => execGscSubmitSitemap(i as unknown as Parameters<typeof execGscSubmitSitemap>[0], c),",
        "  // Phase 8: two-stage approval — agent files approve_blog_pitch.\n"
        "  // On approve, executor creates Framer draft + queues Stage 2 (framer_confirm_publish).\n"
        "  'approve_blog_pitch':        (i, c) =>\n"
        "    execApproveBlogPitch(i as unknown as Parameters<typeof execApproveBlogPitch>[0], c),\n\n"
        "  // GSC\n"
        "  'gsc_submit_sitemap':        (i, c) => execGscSubmitSitemap(i as unknown as Parameters<typeof execGscSubmitSitemap>[0], c),",
        'dispatcher.ts HANDLERS map',
    )
    P.write_text(src)
    print('[6/11] dispatcher.ts — registered approve_blog_pitch')

# ── 7. presenter.ts — thread requestApproval + approvalResolved ─────────────
P = ROOT / 'src/core/slack/presenter.ts'
src = must_read(P)
if '// Phase 8: thread approval' in src:
    print('[7/11] presenter.ts already threads approvals — skipping')
else:
    # getRun is already imported; this.pool is already on the class. Just replace
    # the method bodies to thread.
    src = replace_one(
        src,
        "  async requestApproval(input: ApprovalRequestInput): Promise<void> {\n"
        "    await this.postChannel(input.tenantId, input.channelId, renderApprovalRequest(input));\n"
        "    this.logger.info('slack_approval_posted', {\n"
        "      tenantId: input.tenantId, taskId: input.taskId,\n"
        "      tool: input.toolName, approvalId: input.approvalId,\n"
        "    });\n"
        "  }",
        "  // Phase 8: thread approval cards under the run's anchor message so the\n"
        "  // channel stays clean. Falls back to channel-level if no run row exists.\n"
        "  async requestApproval(input: ApprovalRequestInput): Promise<void> {\n"
        "    const run = await getRun(this.pool, input.taskId);\n"
        "    if (run?.anchorTs) {\n"
        "      await this.postThread(input.tenantId, input.channelId, run.anchorTs,\n"
        "        renderApprovalRequest(input));\n"
        "    } else {\n"
        "      await this.postChannel(input.tenantId, input.channelId, renderApprovalRequest(input));\n"
        "    }\n"
        "    this.logger.info('slack_approval_posted', {\n"
        "      tenantId: input.tenantId, taskId: input.taskId,\n"
        "      tool: input.toolName, approvalId: input.approvalId,\n"
        "      threaded: !!run?.anchorTs,\n"
        "    });\n"
        "  }",
        'presenter.ts requestApproval',
    )
    src = replace_one(
        src,
        "  async approvalResolved(input: ApprovalResolvedInput): Promise<void> {\n"
        "    await this.postChannel(input.tenantId, input.channelId, renderApprovalResolved(input));\n"
        "    this.logger.info('slack_approval_resolved', {\n"
        "      tenantId: input.tenantId, taskId: input.taskId,\n"
        "      tool: input.toolName, decision: input.decision,\n"
        "    });\n"
        "  }",
        "  // Phase 8: thread approval-resolved messages too.\n"
        "  async approvalResolved(input: ApprovalResolvedInput): Promise<void> {\n"
        "    const run = await getRun(this.pool, input.taskId);\n"
        "    if (run?.anchorTs) {\n"
        "      await this.postThread(input.tenantId, input.channelId, run.anchorTs,\n"
        "        renderApprovalResolved(input));\n"
        "    } else {\n"
        "      await this.postChannel(input.tenantId, input.channelId, renderApprovalResolved(input));\n"
        "    }\n"
        "    this.logger.info('slack_approval_resolved', {\n"
        "      tenantId: input.tenantId, taskId: input.taskId,\n"
        "      tool: input.toolName, decision: input.decision,\n"
        "      threaded: !!run?.anchorTs,\n"
        "    });\n"
        "  }",
        'presenter.ts approvalResolved',
    )
    # Thread the execution result too
    src = replace_one(
        src,
        "  async notifyExecutionResult(input: ExecutionResultInput): Promise<void> {\n"
        "    try {\n"
        "      await this.postChannel(input.tenantId, input.channelId, renderExecutionResult(input));\n"
        "      this.logger.info('slack_execution_result_posted', {",
        "  // Phase 8: thread execution-result notification too.\n"
        "  async notifyExecutionResult(input: ExecutionResultInput): Promise<void> {\n"
        "    try {\n"
        "      const run = await getRun(this.pool, input.taskId);\n"
        "      if (run?.anchorTs) {\n"
        "        await this.postThread(input.tenantId, input.channelId, run.anchorTs,\n"
        "          renderExecutionResult(input));\n"
        "      } else {\n"
        "        await this.postChannel(input.tenantId, input.channelId, renderExecutionResult(input));\n"
        "      }\n"
        "      this.logger.info('slack_execution_result_posted', {",
        'presenter.ts notifyExecutionResult',
    )
    P.write_text(src)
    print('[7/11] presenter.ts — threaded requestApproval + approvalResolved + notifyExecutionResult')

# ── 8. render.ts — inferActionKind for approve_blog_pitch ───────────────────
P = ROOT / 'src/core/slack/render.ts'
src = must_read(P)
if "approve_blog_pitch" in src:
    print('[8/11] render.ts already maps approve_blog_pitch — skipping')
else:
    src = replace_one(
        src,
        "  if (n === 'framer_create_and_publish_blog_post') return 'publish_content'",
        "  if (n === 'framer_create_and_publish_blog_post') return 'publish_content'\n"
        "  // Phase 8: two-stage approval Stage 1 — pitch maps to publish_content\n"
        "  // so the operator sees the right icon and 'Approve & publish' label.\n"
        "  if (n === 'approve_blog_pitch')                  return 'publish_content'",
        'render.ts inferActionKind',
    )
    P.write_text(src)
    print('[8/11] render.ts — mapped approve_blog_pitch → publish_content')

# ── 9. skills/seo/tools.ts — rewrite propose_action desc + URL fix ──────────
P = ROOT / 'src/skills/seo/tools.ts'
src = must_read(P)
if 'approve_blog_pitch' in src:
    print('[9/11] seo/tools.ts already mentions approve_blog_pitch — skipping')
else:
    # Replace any /blog/ paths with /resources/
    src = src.replace('https://tarino.au/blog/', 'https://tarino.au/resources/')
    src = src.replace('tarino.au/blog/<slug>', 'tarino.au/resources/<slug>')
    # Update propose_action description block — find the tool definition and
    # replace the description string fully.
    old_desc_marker = "\"Set previewUrl to https://tarino.au/resources/<slug> for the post-publish link (the operator clicks it after approving).\\n\\n\""
    new_desc_marker = "\"Set previewUrl to https://tarino.au/resources/<slug> for the post-publish link (the operator clicks it after approving the publish stage).\\n\\n\""
    if old_desc_marker in src:
        src = src.replace(old_desc_marker, new_desc_marker)
    # Insert mention of approve_blog_pitch as the primary blog-post path. Anchor
    # on a stable phrase from the description that we know is there (the
    # Phase 6 propose_action description rewrite). If the anchor doesn't match,
    # the script will surface a clear error.
    # Section 9b below does the actual description rewrite via prepend.
    P.write_text(src)
    print('[9/11] seo/tools.ts — URL fixes applied')

# ── 9b. Rewrite propose_action description in seo/tools.ts more carefully ───
# We prepend the approve_blog_pitch routing block as the FIRST item in the
# bulleted list of executor names, before framer_create_and_publish_blog_post.
src = must_read(P)
if "approve_blog_pitch" not in src:
    anchor = (
        "      \"You MUST set toolName to ONE of these registered executor names:\\n\\n\" +\n"
        "      \"  • framer_create_and_publish_blog_post — atomic create + publish of a NEW blog post on the Framer Blog. \" +"
    )
    replacement = (
        "      \"You MUST set toolName to ONE of these registered executor names:\\n\\n\" +\n"
        "      \"  • approve_blog_pitch — PRIMARY path for NEW blog posts (Phase 8 two-stage flow). \" +\n"
        "      \"toolInput = { slug: <kebab-case>, title: <string>, content: <full HTML in Framer formattedText>, imageUrl: <Pexels landscape URL>, whyThisTopic?: <one-sentence rationale for the operator> }. \" +\n"
        "      \"This files a PITCH approval. On approve: a Framer draft is created (operator can review in Framer's editor) AND a SECOND approval card appears in the same Slack thread for the publish gate. \" +\n"
        "      \"On reject: nothing is created in Framer. \" +\n"
        "      \"Set previewUrl to https://tarino.au/resources/<slug> — operator visits this AFTER the publish stage approval.\\n\\n\" +\n"
        "      \"  • framer_create_and_publish_blog_post — DEPRECATED single-stage path. Do not use for new posts. \" +"
    )
    if anchor in src:
        src = src.replace(anchor, replacement)
        P.write_text(src)
        print('[9b/11] seo/tools.ts — prepended approve_blog_pitch to propose_action description')
    else:
        print('[9b/11] WARNING — propose_action description anchor not found; skipping')
        sys.exit(1)
else:
    print('[9b/11] seo/tools.ts already mentions approve_blog_pitch — skipping')

# ── 10. agents/subagent.ts — rewrite "On Framer blog posts" + URL fix ───────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
# URL fix everywhere
src_before = src
src = src.replace('https://tarino.au/blog/', 'https://tarino.au/resources/')
src = src.replace('tarino.au/blog/<slug>', 'tarino.au/resources/<slug>')
src = src.replace('tarino.au/blog/(slug)', 'tarino.au/resources/(slug)')
if src != src_before:
    P.write_text(src)
    print('[10a/11] subagent.ts — URL paths fixed')

# Now replace the "On Framer blog posts" section with the two-stage version
if 'approve_blog_pitch' in src:
    print('[10b/11] subagent.ts already mentions approve_blog_pitch — skipping')
else:
    old_section = '''## On Framer blog posts

To propose a new blog post (atomic create + publish, no orphan drafts):

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes with your post.

2. Call framer_list_blog_items. Two purposes:
   (a) Confirm your proposed slug is unique.
   (b) Pick 2-3 of the most recent posts and study them — they ARE the voice you should write in. Mirror cadence, paragraph length, register, and structure (how long is the intro? how often are subheads used? does the post tend to end with a CTA or a thought?). The tone is the operator\'s real voice; do not invent your own.

3. Write the post in full — title + slug + content. Content is HTML in Framer\'s formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.

4. Inside the body, embed 2-4 internal links to other Tarino posts where the cross-reference is genuinely useful (not gratuitous). Format: <a href="/blog/SLUG">descriptive anchor text</a> — use the slug from framer_list_blog_items. Anchor text should be a real noun phrase from the sentence, not "click here" or the bare title.

5. Call pexels_search with a 2-4 word CONCRETE-NOUN query that reflects the post subject — "australian small business owner laptop", "calculator paperwork desk", "warehouse logistics team". Avoid abstract phrases like "offshore hiring" (they return cliché globe-handshake stock). Pick the most editorially-relevant result. Use the "url_for_post" field from the response — that\'s the landscape-cropped URL ready to drop into Framer.

6. File propose_action with:
     toolName       = "framer_create_and_publish_blog_post"
     toolInput      = { slug, title, content, imageUrl }
     proposedAction = one-line plain-English summary for the Slack card
     priority       = P0 / P1 / P2 / P3
     previewUrl     = the post-publish URL the operator can visit after approving (https://tarino.au/resources/ followed by the slug)

On approval: executor creates the CMS item AND publishes the site atomically. The post goes live at https://tarino.au/resources/(slug) within seconds — with the chosen image and embedded internal links intact.
On rejection: nothing is created. No cleanup needed.

Note: do NOT call framer_draft_blog_post for new posts — that\'s the legacy two-phase path. The atomic path is cleaner because the operator approves CONTENT (not just a publish), and rejection leaves no cruft in the Blog collection.

For changes Framer\'s API can\'t do programmatically — editing existing pages, SEO meta on pages, internal linking inside existing posts, schema markup, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer\'s editor without further input from you. Include verbatim code blocks for schema, exact anchor text + source/target pages for linking, full revised copy for content tweaks.'''

    new_section = '''## On Framer blog posts (two-stage approval, Phase 8)

Two operator-facing gates: PITCH (you propose; operator says is-this-worth-writing?) then PUBLISH (operator reviews the actual draft in Framer; says ship-it?). Both are propose_action calls — you only ever file one card per post. The second card is created by the executor on the operator\'s first approval.

To propose a new blog post:

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes.

2. Call framer_list_blog_items. Two purposes:
   (a) Confirm your proposed slug is unique.
   (b) Pick 2-3 of the most recent posts and study them — they ARE the voice you write in. Mirror cadence, paragraph length, register, and structure. The tone is the operator\'s real voice; do not invent your own.

3. Write the post in full — title + slug + content. Content is HTML in Framer\'s formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.

4. Inside the body, embed 2-4 internal links to other Tarino posts where the cross-reference is genuinely useful (not gratuitous). Format: <a href="/resources/SLUG">descriptive anchor text</a> — use slugs from framer_list_blog_items. Anchor text should be a real noun phrase from the sentence.

5. Call pexels_search with a 2-4 word CONCRETE-NOUN query that reflects the post subject — "australian small business owner laptop", "calculator paperwork desk", "warehouse logistics team". Avoid abstract phrases. Pick the most editorially-relevant result. Use the "url_for_post" field — that\'s the landscape-cropped URL.

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

Critical: do NOT call framer_draft_blog_post yourself. Do NOT use toolName \\'framer_create_and_publish_blog_post\\' (deprecated single-stage path). The draft creation happens server-side after Stage 1 approval — you only file the pitch.

For non-blog work — schema markup, internal linking inside EXISTING posts, copy edits on live pages, meta tag updates, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer\'s editor without further input from you.'''

    if old_section in src:
        src = src.replace(old_section, new_section)
        P.write_text(src)
        print('[10b/11] subagent.ts — "On Framer blog posts" rewritten for two-stage flow')
    else:
        print('[10b/11] WARNING — could not find old Phase 7 "On Framer blog posts" section; subagent prompt NOT updated')
        sys.exit(1)

# ── 11. framer/tools.ts — URL fix in tool description ──────────────────────
P = ROOT / 'src/integrations/framer/tools.ts'
src = must_read(P)
src_before = src
src = src.replace('https://tarino.au/blog/', 'https://tarino.au/resources/')
src = src.replace('tarino.au/blog/<slug>', 'tarino.au/resources/<slug>')
src = src.replace('tarino.au/blog/(slug)', 'tarino.au/resources/(slug)')
if src != src_before:
    P.write_text(src)
    print('[11/11] framer/tools.ts — URL paths fixed')
else:
    print('[11/11] framer/tools.ts — no /blog/ references found; skipping')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push. After deploy, apply the SQL migration:')
print('  psql "$DATABASE_URL" -f sql/20260515-phase8-two-stage-approval.sql')
print('Or wait for the next migrate.ts boot run to apply it automatically.')
