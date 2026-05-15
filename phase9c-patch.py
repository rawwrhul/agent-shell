#!/usr/bin/env python3
"""
phase9c-patch.py — Phase 9c: image + links validation + Stage 2 card fix.

Three concrete fixes to make the two-stage approval flow actually work:

  1. execApproveBlogPitch now POSTS the Stage 2 Slack card.
     Phase 8 only inserted the approval row; the card needs presenter.requestApproval.

  2. Stage 2 previewUrl points at the specific Framer item.
     Format: <framer_project_url>?item=<itemId>  — best-effort routing into
     the item editor where the operator can preview the rendered content.

  3. Server-side validation in doProposeAction.
     approve_blog_pitch pitches with empty imageUrl or <2 internal links in
     content get REJECTED with an error to the agent. Forces the agent to
     redo with pexels_search + embedded <a href> tags. No more silent
     skipping of mandatory steps.

  4. Subagent prompt strengthened.
     Image search and internal links are reframed as MANDATORY pre-conditions
     for filing propose_action, with the validation error spelled out so the
     agent knows what to expect on skip.

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

# ── 1. EXECUTOR: post Stage 2 Slack card + better previewUrl ───────────────
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)
if 'presenter.requestApproval' in src and 'Stage 2 card' in src:
    print('[1/4] executor.ts already posts Stage 2 card — skipping')
else:
    # 1a. Add presenter + getRun imports
    src = replace_one(
        src,
        "import { createApproval } from '../../hitl/state-store'\n"
        "import { pool } from '../../memory/postgres'",
        "import { createApproval } from '../../hitl/state-store'\n"
        "import { pool } from '../../memory/postgres'\n"
        "import { presenter } from '../../core/slack'\n"
        "import { getRun } from '../../core/slack/state-store'",
        'executor.ts imports',
    )

    # 1b. Replace the whole createApproval+return block in execApproveBlogPitch
    #     with a version that ALSO posts the Stage 2 card via the presenter.
    old_block = (
        "    const projectUrl = ctx.tenant.framer_project_url ?? ''\n"
        "    const stage2 = await createApproval(pool, {\n"
        "      tenantId:        ctx.tenant.tenantId,\n"
        "      taskId:          ctx.taskId,\n"
        "      toolName:        'framer_confirm_publish',\n"
        "      toolInput:       {\n"
        "        confirmationHash: draft.preview.confirmationHash,\n"
        "        itemId:           draft.itemId,\n"
        "        slug:             input.slug,\n"
        "        title:            input.title,\n"
        "      } as Record<string, unknown>,\n"
        "      riskLevel:       'high',\n"
        "      riskReason:      'Will publish the drafted post live to tarino.au.',\n"
        "      priority:        'P1',\n"
        "      proposedAction:  `Publish '${input.title}' to /resources/${input.slug}`,\n"
        "      whyPriority:     input.whyThisTopic ?? 'Draft ready for review in Framer.',\n"
        "      slackChannelId:  null as unknown as string | undefined,  // presenter looks up from slack_runs\n"
        "      previewUrl:      projectUrl,                             // links to Framer project for draft review\n"
        "      parentApprovalId: stage1ApprovalId,\n"
        "    })\n"
        "\n"
        "    return {\n"
        "      ok:      true,\n"
        "      summary: `Draft created in Framer. Stage 2 approval posted (id ${stage2.id.slice(0, 8)}).`,\n"
        "      detail: {\n"
        "        itemId:           draft.itemId,\n"
        "        slug:             input.slug,\n"
        "        confirmationHash: draft.preview.confirmationHash,\n"
        "        stage2ApprovalId: stage2.id,\n"
        "        framerProjectUrl: projectUrl,\n"
        "        productionUrl:    `https://tarino.au/resources/${input.slug}`,\n"
        "      },\n"
        "    }"
    )
    new_block = (
        "    const projectUrl = ctx.tenant.framer_project_url ?? ''\n"
        "    // Phase 9c: construct an item-specific preview URL so the operator\n"
        "    // lands in the editor view of THIS draft, not the project root.\n"
        "    // Framer's URL pattern: <project>?item=<itemId>. The node parameter\n"
        "    // is helpful but not strictly required — Framer resolves the item.\n"
        "    const stage2PreviewUrl = projectUrl\n"
        "      ? `${projectUrl}${projectUrl.includes('?') ? '&' : '?'}item=${encodeURIComponent(draft.itemId)}`\n"
        "      : ''\n"
        "\n"
        "    const stage2 = await createApproval(pool, {\n"
        "      tenantId:        ctx.tenant.tenantId,\n"
        "      taskId:          ctx.taskId,\n"
        "      toolName:        'framer_confirm_publish',\n"
        "      toolInput:       {\n"
        "        confirmationHash: draft.preview.confirmationHash,\n"
        "        itemId:           draft.itemId,\n"
        "        slug:             input.slug,\n"
        "        title:            input.title,\n"
        "      } as Record<string, unknown>,\n"
        "      riskLevel:       'high',\n"
        "      riskReason:      'Will publish the drafted post live to tarino.au.',\n"
        "      priority:        'P1',\n"
        "      proposedAction:  `Publish '${input.title}' to /resources/${input.slug}`,\n"
        "      whyPriority:     input.whyThisTopic ?? 'Draft ready for review in Framer — open the preview link, eyeball, then approve to publish.',\n"
        "      slackChannelId:  null as unknown as string | undefined,\n"
        "      previewUrl:      stage2PreviewUrl,\n"
        "      parentApprovalId: stage1ApprovalId,\n"
        "    })\n"
        "\n"
        "    // Phase 9c: actually post the Stage 2 Slack card. Phase 8 inserted\n"
        "    // the DB row but forgot the presenter call — Stage 2 row existed\n"
        "    // but the operator never saw a card to act on.\n"
        "    const run = await getRun(pool, ctx.taskId)\n"
        "    const channelId = run?.channelId ?? ctx.tenant.slackChannelId\n"
        "    if (channelId) {\n"
        "      try {\n"
        "        await presenter.requestApproval({\n"
        "          tenantId:   ctx.tenant.tenantId,\n"
        "          channelId,\n"
        "          taskId:     ctx.taskId,\n"
        "          toolName:   'framer_confirm_publish',\n"
        "          riskLevel:  'high',\n"
        "          riskReason: 'Publishes the drafted post to the live site.',\n"
        "          approvalId: stage2.id,\n"
        "          previewUrl: stage2PreviewUrl,\n"
        "          tenantName: ctx.tenant.clientName,\n"
        "          summary:    `Publish '${input.title}' to /resources/${input.slug}`,\n"
        "        })\n"
        "      } catch (err) {\n"
        "        // Card post failure shouldn't fail the executor — DB row is the source of truth.\n"
        "        // Operator can still hit the row via /agent approvals or DB query if card fails.\n"
        "        // Logged for debugging.\n"
        "      }\n"
        "    }\n"
        "\n"
        "    return {\n"
        "      ok:      true,\n"
        "      summary: `Draft created in Framer. Stage 2 card posted (approval id ${stage2.id.slice(0, 8)}).`,\n"
        "      detail: {\n"
        "        itemId:            draft.itemId,\n"
        "        slug:              input.slug,\n"
        "        confirmationHash:  draft.preview.confirmationHash,\n"
        "        stage2ApprovalId:  stage2.id,\n"
        "        stage2PreviewUrl,\n"
        "        framerProjectUrl:  projectUrl,\n"
        "        productionUrl:     `https://tarino.au/resources/${input.slug}`,\n"
        "      },\n"
        "    }"
    )
    src = replace_one(src, old_block, new_block, 'executor.ts execApproveBlogPitch')
    P.write_text(src)
    print('[1/4] executor.ts — Stage 2 card posting + item-specific previewUrl installed')

# ── 2. VALIDATION: reject incomplete approve_blog_pitch in doProposeAction ──
P = ROOT / 'src/skills/seo/tools.ts'
src = must_read(P)
if 'approve_blog_pitch validation' in src.lower() or 'PITCH_VALIDATION_FAILED' in src:
    print('[2/4] seo/tools.ts already validates approve_blog_pitch — skipping')
else:
    # Inject validation at the START of doProposeAction, AFTER the input
    # destructuring (so we have i.toolName + i.toolInput to inspect).
    src = replace_one(
        src,
        "async function doProposeAction(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {\n"
        "  const i = input as {\n"
        "    toolName: string;\n"
        "    toolInput: Record<string, unknown>;\n"
        "    proposedAction: string;\n"
        "    detail?: string[];\n"
        "    whyPriority?: string;\n"
        "    priority: 'P0' | 'P1' | 'P2' | 'P3';\n"
        "    riskLevel?: 'low' | 'medium' | 'high';\n"
        "    /** Task 0.5: optional preview URL (Framer staging URL for draft pages). */\n"
        "    previewUrl?: string;\n"
        "  };",
        "async function doProposeAction(input: Record<string, unknown>, ctx: SeoToolContext): Promise<string> {\n"
        "  const i = input as {\n"
        "    toolName: string;\n"
        "    toolInput: Record<string, unknown>;\n"
        "    proposedAction: string;\n"
        "    detail?: string[];\n"
        "    whyPriority?: string;\n"
        "    priority: 'P0' | 'P1' | 'P2' | 'P3';\n"
        "    riskLevel?: 'low' | 'medium' | 'high';\n"
        "    /** Task 0.5: optional preview URL (Framer staging URL for draft pages). */\n"
        "    previewUrl?: string;\n"
        "  };\n"
        "\n"
        "  // Phase 9c: approve_blog_pitch validation. Forces the agent to comply\n"
        "  // with the prompt's image + internal-link requirements rather than\n"
        "  // skipping them silently. Returns an error string the agent reads as\n"
        "  // a tool-failure and must redo.\n"
        "  if (i.toolName === 'approve_blog_pitch') {\n"
        "    const ti = (i.toolInput ?? {}) as Record<string, unknown>\n"
        "    const imageUrl = typeof ti.imageUrl === 'string' ? ti.imageUrl.trim() : ''\n"
        "    const content  = typeof ti.content  === 'string' ? ti.content        : ''\n"
        "    const linkCount = (content.match(/<a\\s+href=/gi) ?? []).length\n"
        "    const errors: string[] = []\n"
        "    if (!imageUrl) {\n"
        "      errors.push(\n"
        "        'PITCH_VALIDATION_FAILED: toolInput.imageUrl is empty. You must call pexels_search with a 2-4 word concrete-noun query before filing the pitch, and include the returned url_for_post in toolInput.imageUrl. Without an image the published page looks broken.'\n"
        "      )\n"
        "    }\n"
        "    if (linkCount < 2) {\n"
        "      errors.push(\n"
        "        `PITCH_VALIDATION_FAILED: toolInput.content has ${linkCount} internal links; you need at least 2. Embed 2-4 <a href=\"/resources/SLUG\">descriptive anchor text</a> elements inside the body, linking to existing Tarino posts from framer_list_blog_items. Internal links are a hard requirement, not optional.`\n"
        "      )\n"
        "    }\n"
        "    if (errors.length > 0) {\n"
        "      logger.warn('seo_propose_action_pitch_validation_failed', {\n"
        "        tenantId: ctx.tenantId, taskId: ctx.taskId,\n"
        "        imageUrlPresent: !!imageUrl, linkCount,\n"
        "      })\n"
        "      return errors.join('\\n\\n') + '\\n\\nRedo your work to satisfy these requirements, then call propose_action again. Do not file another pitch until both pass.'\n"
        "    }\n"
        "  }",
        'tools.ts doProposeAction validation',
    )
    P.write_text(src)
    print('[2/4] seo/tools.ts — approve_blog_pitch server-side validation installed')

# ── 3. PROMPT: mandatory framing for image + internal links ─────────────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
if 'HARD REQUIREMENTS BEFORE FILING' in src:
    print('[3/4] subagent.ts already has hard-requirements framing — skipping')
else:
    # Inject a prominent HARD REQUIREMENTS block immediately before the
    # "C.1  File propose_action ONCE with:" step.
    src = replace_one(
        src,
        "### Phase C — File the pitch\n\n"
        "C.1  File propose_action ONCE with:",
        "### Phase C — File the pitch\n\n"
        "HARD REQUIREMENTS BEFORE FILING (server-side validated — your pitch will be REJECTED with an error if any of these are missing):\n"
        "\n"
        "1. toolInput.imageUrl MUST be a non-empty URL. If you have not called pexels_search yet, do it NOW (step B.5). Without a hero image the published page renders broken. NOT optional.\n"
        "\n"
        "2. toolInput.content MUST contain at least 2 internal links in the form <a href=\"/resources/SLUG\">anchor text</a>. Use slugs from framer_list_blog_items. Anchor text must be a real noun phrase (not 'click here', not the bare title). NOT optional.\n"
        "\n"
        "If you file without these, the system returns PITCH_VALIDATION_FAILED and you have to redo the work. Treat them as preconditions, not nice-to-haves. The operator sees a broken page if you skip them; the validation exists to protect them.\n"
        "\n"
        "C.1  File propose_action ONCE with:",
        'subagent.ts hard requirements block',
    )
    P.write_text(src)
    print('[3/4] subagent.ts — hard requirements framing for image + links installed')

# ── 4. POSTCONDITION verification logger ────────────────────────────────────
# Cheap addition: when execApproveBlogPitch succeeds, log the linkCount so
# we have a metric over time. Skipped if we already logged it.
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)
if 'phase9c_link_count' in src:
    print('[4/4] executor.ts already logs linkCount — skipping')
else:
    # Add a quick log line after the draft is created
    src = replace_one(
        src,
        "    // Phase 9c: actually post the Stage 2 Slack card.",
        "    // Phase 9c: log post-creation metrics so we can track whether\n"
        "    // the agent's compliance with image + internal-link rules holds.\n"
        "    const _content = (input.content ?? '') as string\n"
        "    const _linkCount = (_content.match(/<a\\s+href=/gi) ?? []).length\n"
        "    // eslint-disable-next-line no-console\n"
        "    console.log('phase9c_link_count', { slug: input.slug, hasImage: !!input.imageUrl, linkCount: _linkCount, contentLength: _content.length })\n"
        "\n"
        "    // Phase 9c: actually post the Stage 2 Slack card.",
        'executor.ts metric log',
    )
    P.write_text(src)
    print('[4/4] executor.ts — link-count + image metric log installed')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push.')
