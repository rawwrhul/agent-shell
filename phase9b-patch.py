#!/usr/bin/env python3
"""
phase9b-patch.py — Thread feedback for pitch refinement.

Adds a new capability: when the operator replies in a thread under one of
our run anchors, the bot reads the reply as feedback on the pending pitch
and refines the pitch in place. Three outcomes:

  refined — agent makes the change, DB and (if Stage 2) Framer draft are
            updated, thread reply tells the operator what changed and where
            to re-review.
  clarify — feedback is ambiguous; agent asks a follow-up in the thread.
            No state change.
  reject  — feedback is out of scope (e.g. image swap, topic change);
            agent explains in the thread. No state change.

STAGE AWARENESS:
  Stage 1 (tool_name = 'approve_blog_pitch'):
    The pitch lives only in approval_requests.tool_input. Refinement
    updates the JSON in place. No Framer write yet — the draft doesn't
    exist until Stage 1 is approved.

  Stage 2 (tool_name = 'framer_confirm_publish'):
    The pitch is a live Framer draft. Refinement uses removeItems +
    addItems + preview to rewrite the item — this generates a new itemId
    and confirmationHash. The Stage 2 approval row is updated with the
    new values, the operator gets a new preview URL in the thread reply.

MVP SCOPE — text refinement only:
  The refiner is a single Anthropic call (no tools). It can update
  title, content, whyThisTopic. It CANNOT swap images, change slugs, or
  pitch a different topic. Those return 'clarify' or 'reject' so the
  operator knows to reject + re-task.

  Future work (Phase 9b.2): mini agent loop with pexels_search tool to
  enable image swap directly from thread feedback.

Files:
  1. NEW src/feedback/prompts.ts        — refiner system prompt
  2. NEW src/feedback/refiner.ts        — single Anthropic call
  3. NEW src/feedback/state.ts          — DB helpers (find pitch, update tool_input)
  4. NEW src/feedback/framer-rewrite.ts — Stage 2 Framer remove+re-add helper
  5. NEW src/feedback/handler.ts        — top-level orchestration
  6. EDIT src/integrations/framer/client.ts — add getBlogItemContent helper
  7. EDIT src/core/slack/state-store.ts     — add findRunByAnchorTs reverse lookup
  8. EDIT src/tenants/slackManager.ts       — wire app.event('message') handler

SLACK APP DASHBOARD CONFIG (after deploy):
  Without these, the message handler never fires and refinement silently
  no-ops. Walk through these manually:
    1. https://api.slack.com/apps/<your-app-id>/oauth
       Add Bot Token Scopes: channels:history, groups:history
    2. https://api.slack.com/apps/<your-app-id>/event-subscriptions
       Subscribe to bot events: message.channels, message.groups
    3. Reinstall the app to your workspace (scopes don't apply until
       reinstall — the dashboard will prompt you with a button)
    4. Verify the bot is a member of the channel where you trigger runs

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
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:500]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)


# ── 1. NEW: src/feedback/prompts.ts ───────────────────────────────────────
P = ROOT / 'src/feedback/prompts.ts'
P.parent.mkdir(parents=True, exist_ok=True)
if P.exists() and 'REFINER_SYSTEM_PROMPT' in P.read_text():
    print('[1/8] feedback/prompts.ts already exists — skipping')
else:
    P.write_text(
        "// src/feedback/prompts.ts\n"
        "//\n"
        "// System prompt for the pitch refiner. Single Anthropic call (no tools).\n"
        "// Reads the current pitch + operator feedback, returns structured JSON.\n"
        "\n"
        "export const REFINER_SYSTEM_PROMPT = `You are a pitch refinement agent for an SEO content workflow. An operator has reviewed a pending blog post pitch and replied in Slack with feedback. Your job is to:\n"
        "\n"
        "1. Read the current pitch (title, content, whyThisTopic) and the operator's feedback.\n"
        "2. Decide one of three actions:\n"
        "   - refined: you can make the change. Produce updated text. Be specific in your change_summary about what you changed and why.\n"
        "   - clarify: feedback is ambiguous (e.g. \"this is weak\" without a clear referent, or you genuinely don't understand). Ask ONE concise follow-up question in change_summary.\n"
        "   - reject: feedback is out of scope for this refinement loop. Out-of-scope means: image swaps, slug changes, picking a different topic entirely, or anything requiring tool calls. In change_summary, explain briefly and tell the operator to reject the approval and start a new task with the feedback as the brief.\n"
        "\n"
        "## What you CAN refine\n"
        "\n"
        "- title (string): the post title\n"
        "- content (HTML string in Framer formattedText): the post body — paragraphs, headings, lists, anchor tags. Preserve formatting structure. When rewriting a section, match the existing voice and structural conventions of the rest of the post.\n"
        "- whyThisTopic (string): the short rationale shown to the operator on the approval card\n"
        "\n"
        "## What you CANNOT refine (return 'reject' or 'clarify')\n"
        "\n"
        "- imageUrl: image swap requires a Pexels search you can't run from this loop\n"
        "- slug: URL changes break in-flight Framer state\n"
        "- topic / framing change: that's a new pitch, not a refinement\n"
        "- anything requiring web fetch, SERP analysis, fresh research\n"
        "\n"
        "## Editorial rules when refining\n"
        "\n"
        "- Make the SMALLEST change that satisfies the feedback. Don't rewrite paragraphs unless asked.\n"
        "- Preserve the existing internal links (\\\\<a href=\\\"/resources/...\\\"\\\\>) in the content body. If the operator asks you to remove one specifically, fine, but don't drop them silently.\n"
        "- Preserve the existing tone and voice. If feedback is \"more direct\" or \"less salesy\", interpret narrowly — adjust the specific section, don't overhaul the whole piece.\n"
        "- For \"section X is weak\" feedback: identify which heading or paragraph block the operator means based on content. If genuinely ambiguous, return 'clarify' and ask which section.\n"
        "\n"
        "## Output format\n"
        "\n"
        "Return ONLY a single JSON object. No preamble, no markdown fence, no commentary.\n"
        "\n"
        "{\n"
        "  \"action\": \"refined\" | \"clarify\" | \"reject\",\n"
        "  \"updated\": {                              // include ONLY if action is 'refined'. Include ONLY fields you changed.\n"
        "    \"title\":        \"...\",                 // optional\n"
        "    \"content\":      \"<p>...</p>\",          // optional, full body HTML if any block changed\n"
        "    \"whyThisTopic\": \"...\"                  // optional\n"
        "  },\n"
        "  \"change_summary\": \"...\"                  // always present. For 'refined': what changed (1-2 sentences, operator-readable). For 'clarify': the question. For 'reject': brief reason + 'reject this approval and start a new task'.\n"
        "}`\n"
        "\n"
        "/**\n"
        " * Builds the user-message portion of the refiner call. The system prompt is\n"
        " * constant; this varies with the pitch + feedback.\n"
        " */\n"
        "export function buildRefinerUserMessage(input: {\n"
        "  stage:        'stage1' | 'stage2'\n"
        "  title:        string\n"
        "  whyThisTopic: string\n"
        "  content:      string\n"
        "  feedback:     string\n"
        "}): string {\n"
        "  return [\n"
        "    `Stage: ${input.stage === 'stage1' ? 'Stage 1 (pre-draft) — refinement updates the pitch DB record only. No Framer write yet.' : 'Stage 2 (post-draft) — refinement will rewrite the existing Framer draft. The operator has likely seen the rendered preview.'}`,\n"
        "    '',\n"
        "    '<current_pitch>',\n"
        "    `  <title>${input.title}</title>`,\n"
        "    `  <why_this_topic>${input.whyThisTopic}</why_this_topic>`,\n"
        "    '  <content>',\n"
        "    input.content,\n"
        "    '  </content>',\n"
        "    '</current_pitch>',\n"
        "    '',\n"
        "    '<operator_feedback>',\n"
        "    input.feedback,\n"
        "    '</operator_feedback>',\n"
        "    '',\n"
        "    'Apply the refinement now. Return only JSON.',\n"
        "  ].join('\\\\n')\n"
        "}\n"
    )
    print('[1/8] feedback/prompts.ts — refiner prompt created')

# ── 2. NEW: src/feedback/refiner.ts ───────────────────────────────────────
P = ROOT / 'src/feedback/refiner.ts'
if P.exists() and 'runRefiner' in P.read_text():
    print('[2/8] feedback/refiner.ts already exists — skipping')
else:
    P.write_text(
        "// src/feedback/refiner.ts\n"
        "//\n"
        "// Single Anthropic call that takes the current pitch + operator feedback\n"
        "// and returns a structured refinement decision. No tools — pure text-in /\n"
        "// JSON-out. Tool-enabled refinement (image swaps etc.) is future work.\n"
        "\n"
        "import Anthropic from '@anthropic-ai/sdk'\n"
        "import { config } from '../config'\n"
        "import { logger } from '../logger'\n"
        "import { REFINER_SYSTEM_PROMPT, buildRefinerUserMessage } from './prompts'\n"
        "\n"
        "const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })\n"
        "\n"
        "export interface RefinerInput {\n"
        "  stage:        'stage1' | 'stage2'\n"
        "  title:        string\n"
        "  whyThisTopic: string\n"
        "  content:      string\n"
        "  feedback:     string\n"
        "}\n"
        "\n"
        "export interface RefinerOutput {\n"
        "  action:        'refined' | 'clarify' | 'reject'\n"
        "  updated?:      {\n"
        "    title?:        string\n"
        "    content?:      string\n"
        "    whyThisTopic?: string\n"
        "  }\n"
        "  changeSummary: string\n"
        "}\n"
        "\n"
        "export async function runRefiner(input: RefinerInput): Promise<RefinerOutput> {\n"
        "  const userMessage = buildRefinerUserMessage(input)\n"
        "\n"
        "  const response = await anthropic.messages.create({\n"
        "    model:      config.AGENT_MODEL ?? 'claude-sonnet-4-6',\n"
        "    max_tokens: 4096,\n"
        "    system:     REFINER_SYSTEM_PROMPT,\n"
        "    messages:   [{ role: 'user', content: userMessage }],\n"
        "  })\n"
        "\n"
        "  const textBlock = response.content.find(b => b.type === 'text')\n"
        "  if (!textBlock || textBlock.type !== 'text') {\n"
        "    throw new Error('Refiner returned no text content')\n"
        "  }\n"
        "\n"
        "  // Strip any markdown fences the model might emit despite instructions.\n"
        "  const raw = textBlock.text.trim()\n"
        "    .replace(/^```json\\s*/i, '')\n"
        "    .replace(/^```\\s*/, '')\n"
        "    .replace(/```\\s*$/, '')\n"
        "    .trim()\n"
        "\n"
        "  let parsed: RefinerOutput\n"
        "  try {\n"
        "    parsed = JSON.parse(raw) as RefinerOutput\n"
        "  } catch (err) {\n"
        "    logger.error('refiner_json_parse_failed', { rawSnippet: raw.slice(0, 400), err: String(err) })\n"
        "    throw new Error('Refiner returned invalid JSON')\n"
        "  }\n"
        "\n"
        "  // Defensive normalisation — action must be one of the three, change_summary must exist.\n"
        "  if (!['refined', 'clarify', 'reject'].includes(parsed.action)) {\n"
        "    logger.warn('refiner_unknown_action', { action: parsed.action })\n"
        "    return { action: 'clarify', changeSummary: 'I produced an unrecognised response — could you rephrase the feedback?' }\n"
        "  }\n"
        "  if (typeof parsed.changeSummary !== 'string' || !parsed.changeSummary.trim()) {\n"
        "    parsed.changeSummary = parsed.action === 'refined' ? 'Updated the pitch.' : 'No change made.'\n"
        "  }\n"
        "\n"
        "  return parsed\n"
        "}\n"
    )
    print('[2/8] feedback/refiner.ts — Anthropic refiner created')

# ── 3. NEW: src/feedback/state.ts ─────────────────────────────────────────
P = ROOT / 'src/feedback/state.ts'
if P.exists() and 'findPendingPitchForTask' in P.read_text():
    print('[3/8] feedback/state.ts already exists — skipping')
else:
    P.write_text(
        "// src/feedback/state.ts\n"
        "//\n"
        "// DB helpers for the thread-feedback refinement flow.\n"
        "// Lifted out of handler.ts so the SQL is in one place.\n"
        "\n"
        "import type { Pool } from 'pg'\n"
        "import type { ApprovalRow } from '../hitl/state-store'\n"
        "\n"
        "/**\n"
        " * Find the most recent pending approval for a given task. The thread feedback\n"
        " * handler uses this to identify which pitch the operator is commenting on.\n"
        " * Returns null if no pending approval exists (the task may have already been\n"
        " * approved/rejected, or there's no pitch in flight).\n"
        " */\n"
        "export async function findPendingPitchForTask(\n"
        "  pool:   Pool,\n"
        "  taskId: string,\n"
        "): Promise<ApprovalRow | null> {\n"
        "  const res = await pool.query(\n"
        "    `SELECT id, tenant_id AS \"tenantId\", task_id AS \"taskId\",\n"
        "            tool_name AS \"toolName\", tool_input AS \"toolInput\",\n"
        "            status, parent_approval_id AS \"parentApprovalId\",\n"
        "            preview_url AS \"previewUrl\"\n"
        "       FROM approval_requests\n"
        "      WHERE task_id = $1\n"
        "        AND status  = 'pending'\n"
        "        AND tool_name IN ('approve_blog_pitch', 'framer_confirm_publish')\n"
        "      ORDER BY requested_at DESC\n"
        "      LIMIT 1`,\n"
        "    [taskId],\n"
        "  )\n"
        "  if (!res.rows.length) return null\n"
        "  return res.rows[0] as unknown as ApprovalRow\n"
        "}\n"
        "\n"
        "/**\n"
        " * Look up the parent approval (Stage 1) for a given Stage 2 approval row.\n"
        " * Used to recover the original full pitch content when refining at Stage 2 —\n"
        " * Stage 2's own tool_input only has {itemId, confirmationHash, slug, title},\n"
        " * not the content. But the Framer item itself is the live source of truth at\n"
        " * Stage 2; this is kept for reference/audit.\n"
        " */\n"
        "export async function findParentApproval(\n"
        "  pool:               Pool,\n"
        "  parentApprovalId:   string,\n"
        "): Promise<ApprovalRow | null> {\n"
        "  const res = await pool.query(\n"
        "    `SELECT id, tenant_id AS \"tenantId\", task_id AS \"taskId\",\n"
        "            tool_name AS \"toolName\", tool_input AS \"toolInput\",\n"
        "            status, parent_approval_id AS \"parentApprovalId\"\n"
        "       FROM approval_requests\n"
        "      WHERE id = $1`,\n"
        "    [parentApprovalId],\n"
        "  )\n"
        "  if (!res.rows.length) return null\n"
        "  return res.rows[0] as unknown as ApprovalRow\n"
        "}\n"
        "\n"
        "/**\n"
        " * Apply a refinement to an existing approval row's tool_input. Used for\n"
        " * Stage 1 refinements where the pitch lives entirely in the DB and Framer\n"
        " * hasn't been written yet.\n"
        " *\n"
        " * The mergedFields are spread onto the existing tool_input — pass only the\n"
        " * keys that changed.\n"
        " */\n"
        "export async function updateApprovalToolInput(\n"
        "  pool:         Pool,\n"
        "  approvalId:   string,\n"
        "  mergedFields: Record<string, unknown>,\n"
        "): Promise<void> {\n"
        "  // tool_input is JSONB; we merge by reading + writing to keep this driver-agnostic.\n"
        "  const existing = await pool.query(\n"
        "    'SELECT tool_input FROM approval_requests WHERE id = $1',\n"
        "    [approvalId],\n"
        "  )\n"
        "  if (!existing.rows.length) throw new Error(`approval ${approvalId} not found`)\n"
        "  const merged = { ...(existing.rows[0].tool_input ?? {}), ...mergedFields }\n"
        "  await pool.query(\n"
        "    'UPDATE approval_requests SET tool_input = $2, updated_at = NOW() WHERE id = $1',\n"
        "    [approvalId, merged],\n"
        "  )\n"
        "}\n"
    )
    print('[3/8] feedback/state.ts — DB helpers created')

# ── 4. NEW: src/feedback/framer-rewrite.ts ────────────────────────────────
P = ROOT / 'src/feedback/framer-rewrite.ts'
if P.exists() and 'rewriteBlogItem' in P.read_text():
    print('[4/8] feedback/framer-rewrite.ts already exists — skipping')
else:
    P.write_text(
        "// src/feedback/framer-rewrite.ts\n"
        "//\n"
        "// Helper for Stage 2 refinements: remove the existing Framer draft and\n"
        "// re-create it with refined content. The Framer SDK we wrap doesn't expose\n"
        "// an in-place setFieldValues operation, so remove + add is the pattern\n"
        "// that uses methods we know work (already used elsewhere in client.ts).\n"
        "//\n"
        "// Side effect: itemId CHANGES. The Stage 2 approval row's tool_input must\n"
        "// be updated with the new itemId + confirmationHash, and any Slack message\n"
        "// referencing the old preview URL becomes stale (we post a fresh URL in the\n"
        "// thread reply).\n"
        "\n"
        "import * as fr from '../integrations/framer/client'\n"
        "import type { TenantConfig } from '../tenants/types'\n"
        "\n"
        "export interface RewriteInput {\n"
        "  tenant:   TenantConfig\n"
        "  oldItemId: string\n"
        "  slug:     string\n"
        "  title:    string\n"
        "  content:  string\n"
        "  date?:    string\n"
        "  imageUrl?: string\n"
        "}\n"
        "\n"
        "export interface RewriteResult {\n"
        "  newItemId:        string\n"
        "  confirmationHash: string\n"
        "}\n"
        "\n"
        "/**\n"
        " * Replace an existing Blog item with refined content. Performs:\n"
        " *   1. removeItems([oldItemId])\n"
        " *   2. addItems([{slug, fieldData with refined values}])\n"
        " *   3. publishForAgent({action: 'preview'}) → new confirmationHash\n"
        " *\n"
        " * Returns the new itemId + confirmationHash for the caller to write back\n"
        " * to the Stage 2 approval row.\n"
        " *\n"
        " * Caveat: this happens in two separate Framer SDK calls (remove via\n"
        " * removeBlogPost, then add via draftAndPreviewBlogPost). draftAndPreviewBlogPost\n"
        " * has a preflight check that refuses if pending changes exist in the\n"
        " * workspace — but the remove we just did IS a pending change, so we have\n"
        " * to use a lower-level path or accept that quirk. Below uses the public\n"
        " * helpers and works because removeItems doesn't register as a workspace\n"
        " * 'change' in the same way addItems does until a publishForAgent fires.\n"
        " */\n"
        "export async function rewriteBlogItem(input: RewriteInput): Promise<RewriteResult> {\n"
        "  // 1. Remove the old item\n"
        "  await fr.removeBlogPost(input.tenant, input.oldItemId)\n"
        "\n"
        "  // 2. Re-add with refined content. Reuses the existing draft helper which\n"
        "  //    also runs preview and returns the new confirmationHash.\n"
        "  const draft = await fr.draftAndPreviewBlogPost(input.tenant, {\n"
        "    slug:     input.slug,\n"
        "    title:    input.title,\n"
        "    content:  input.content,\n"
        "    date:     input.date,\n"
        "    imageUrl: input.imageUrl,\n"
        "  })\n"
        "\n"
        "  return {\n"
        "    newItemId:        draft.itemId,\n"
        "    confirmationHash: draft.preview.confirmationHash,\n"
        "  }\n"
        "}\n"
    )
    print('[4/8] feedback/framer-rewrite.ts — Stage 2 rewrite helper created')

# ── 5. NEW: src/feedback/handler.ts ───────────────────────────────────────
P = ROOT / 'src/feedback/handler.ts'
if P.exists() and 'handleThreadFeedback' in P.read_text():
    print('[5/8] feedback/handler.ts already exists — skipping')
else:
    P.write_text(
        "// src/feedback/handler.ts\n"
        "//\n"
        "// Top-level orchestration for thread-feedback refinement.\n"
        "//\n"
        "// Called from slackManager's app.event('message') handler when an operator\n"
        "// types a reply in a thread under one of our run anchors.\n"
        "//\n"
        "// Routes Stage 1 vs Stage 2 to the right write path, posts the result back\n"
        "// to the same thread.\n"
        "\n"
        "import type { App } from '@slack/bolt'\n"
        "import { pool } from '../memory/postgres'\n"
        "import { logger } from '../logger'\n"
        "import { getTenant } from '../tenants/registry'\n"
        "import { findPendingPitchForTask, updateApprovalToolInput } from './state'\n"
        "import { runRefiner, type RefinerOutput } from './refiner'\n"
        "import { rewriteBlogItem } from './framer-rewrite'\n"
        "\n"
        "export interface ThreadFeedbackInput {\n"
        "  app:       App\n"
        "  tenantId:  string\n"
        "  taskId:    string\n"
        "  channelId: string\n"
        "  threadTs:  string\n"
        "  feedback:  string\n"
        "  userId:    string\n"
        "}\n"
        "\n"
        "export async function handleThreadFeedback(input: ThreadFeedbackInput): Promise<void> {\n"
        "  const { app, tenantId, taskId, channelId, threadTs, feedback, userId } = input\n"
        "\n"
        "  // 1. Find the pending pitch in this thread.\n"
        "  const pending = await findPendingPitchForTask(pool, taskId)\n"
        "  if (!pending) {\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `I don't see a pending pitch in this thread to refine. If you're responding to an old approval, the action has likely already been resolved.`)\n"
        "    return\n"
        "  }\n"
        "\n"
        "  logger.info('thread_feedback_received', {\n"
        "    tenantId, taskId, approvalId: pending.id, toolName: pending.toolName, userId,\n"
        "    feedbackSnippet: feedback.slice(0, 200),\n"
        "  })\n"
        "\n"
        "  // 2. Determine stage + load current pitch fields.\n"
        "  let stage:        'stage1' | 'stage2'\n"
        "  let currentTitle: string\n"
        "  let currentContent: string\n"
        "  let currentWhy:   string\n"
        "  let currentSlug:  string\n"
        "  let currentImage: string | undefined\n"
        "  let stage2ItemId: string | undefined\n"
        "\n"
        "  if (pending.toolName === 'approve_blog_pitch') {\n"
        "    stage = 'stage1'\n"
        "    const ti = pending.toolInput as Record<string, unknown>\n"
        "    currentTitle   = String(ti.title ?? '')\n"
        "    currentContent = String(ti.content ?? '')\n"
        "    currentWhy     = String(ti.whyThisTopic ?? '')\n"
        "    currentSlug    = String(ti.slug ?? '')\n"
        "    currentImage   = ti.imageUrl ? String(ti.imageUrl) : undefined\n"
        "  } else if (pending.toolName === 'framer_confirm_publish') {\n"
        "    stage = 'stage2'\n"
        "    // Stage 2's tool_input has only {itemId, confirmationHash, slug, title}.\n"
        "    // We need the current content from the Framer item itself (which is the\n"
        "    // live source of truth post-Stage-1-executor).\n"
        "    const ti = pending.toolInput as Record<string, unknown>\n"
        "    stage2ItemId = String(ti.itemId ?? '')\n"
        "    currentSlug  = String(ti.slug  ?? '')\n"
        "    currentTitle = String(ti.title ?? '')\n"
        "\n"
        "    // Pull live content from Framer\n"
        "    const tenant = await getTenant(tenantId)\n"
        "    const fr = await import('../integrations/framer/client')\n"
        "    try {\n"
        "      const item = await fr.getBlogItemContent(tenant, stage2ItemId)\n"
        "      currentContent = item.content\n"
        "      currentTitle   = item.title || currentTitle  // prefer Framer's title if richer\n"
        "      currentImage   = item.imageUrl\n"
        "    } catch (err) {\n"
        "      logger.error('thread_feedback_framer_read_failed', { tenantId, taskId, itemId: stage2ItemId, err: String(err) })\n"
        "      await postThreadReply(app, channelId, threadTs,\n"
        "        `Couldn't read the current draft from Framer — refinement aborted. Try again, or reject this approval and start over.`)\n"
        "      return\n"
        "    }\n"
        "    currentWhy = ''  // not tracked at Stage 2; refiner will ignore if empty\n"
        "  } else {\n"
        "    // Shouldn't happen given findPendingPitchForTask filters, but defensive.\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `The pending action in this thread isn't a refinable pitch (tool: ${pending.toolName}).`)\n"
        "    return\n"
        "  }\n"
        "\n"
        "  // 3. Call the refiner.\n"
        "  let result: RefinerOutput\n"
        "  try {\n"
        "    result = await runRefiner({\n"
        "      stage,\n"
        "      title:        currentTitle,\n"
        "      whyThisTopic: currentWhy,\n"
        "      content:      currentContent,\n"
        "      feedback,\n"
        "    })\n"
        "  } catch (err) {\n"
        "    logger.error('thread_feedback_refiner_failed', { tenantId, taskId, err: String(err) })\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `Refinement failed — I couldn't process that feedback. Try rephrasing, or reject this approval and start fresh.`)\n"
        "    return\n"
        "  }\n"
        "\n"
        "  logger.info('thread_feedback_refiner_result', {\n"
        "    tenantId, taskId, approvalId: pending.id, action: result.action,\n"
        "    changeSummarySnippet: result.changeSummary.slice(0, 200),\n"
        "  })\n"
        "\n"
        "  // 4. Apply the result.\n"
        "  if (result.action === 'clarify') {\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `🤔 ${result.changeSummary}`)\n"
        "    return\n"
        "  }\n"
        "  if (result.action === 'reject') {\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `⚠️ ${result.changeSummary}`)\n"
        "    return\n"
        "  }\n"
        "\n"
        "  // result.action === 'refined'\n"
        "  const updated = result.updated ?? {}\n"
        "  if (!updated.title && !updated.content && !updated.whyThisTopic) {\n"
        "    // Refiner claimed refined but produced no updates — degrade to clarify.\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `🤔 I thought I had a refinement but produced no concrete changes — could you be more specific about what to update?`)\n"
        "    return\n"
        "  }\n"
        "\n"
        "  if (stage === 'stage1') {\n"
        "    // Update tool_input in DB. The executor reads this when Stage 1 is approved.\n"
        "    const fieldsToMerge: Record<string, unknown> = {}\n"
        "    if (updated.title)        fieldsToMerge.title        = updated.title\n"
        "    if (updated.content)      fieldsToMerge.content      = updated.content\n"
        "    if (updated.whyThisTopic) fieldsToMerge.whyThisTopic = updated.whyThisTopic\n"
        "    await updateApprovalToolInput(pool, pending.id, fieldsToMerge)\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `✏️ Updated the pitch — ${result.changeSummary}\\n\\nThe approval card above reflects this. Approve when ready.`)\n"
        "    return\n"
        "  }\n"
        "\n"
        "  // stage === 'stage2': rewrite the Framer draft.\n"
        "  try {\n"
        "    const tenant = await getTenant(tenantId)\n"
        "    const rewriteResult = await rewriteBlogItem({\n"
        "      tenant,\n"
        "      oldItemId: stage2ItemId!,\n"
        "      slug:      currentSlug,\n"
        "      title:     updated.title   ?? currentTitle,\n"
        "      content:   updated.content ?? currentContent,\n"
        "      imageUrl:  currentImage,\n"
        "    })\n"
        "    // Update Stage 2 approval row with new itemId + confirmationHash\n"
        "    await updateApprovalToolInput(pool, pending.id, {\n"
        "      itemId:           rewriteResult.newItemId,\n"
        "      confirmationHash: rewriteResult.confirmationHash,\n"
        "      title:            updated.title ?? currentTitle,\n"
        "    })\n"
        "    // Build a fresh preview URL for the new itemId\n"
        "    const projectUrl = tenant.framer_project_url ?? ''\n"
        "    const newPreviewUrl = projectUrl\n"
        "      ? `${projectUrl}${projectUrl.includes('?') ? '&' : '?'}item=${encodeURIComponent(rewriteResult.newItemId)}`\n"
        "      : ''\n"
        "    const previewLine = newPreviewUrl\n"
        "      ? `\\n\\n*New preview:* <${newPreviewUrl}|Open the updated draft in Framer>`\n"
        "      : ''\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `✏️ Updated the Framer draft — ${result.changeSummary}${previewLine}\\n\\nRefresh your preview tab, then approve the card above when ready.`)\n"
        "  } catch (err) {\n"
        "    logger.error('thread_feedback_framer_rewrite_failed', { tenantId, taskId, err: String(err) })\n"
        "    await postThreadReply(app, channelId, threadTs,\n"
        "      `⚠️ I produced a refinement but couldn't apply it to Framer (${String(err).slice(0, 200)}). Reject this approval and start fresh.`)\n"
        "  }\n"
        "}\n"
        "\n"
        "async function postThreadReply(app: App, channelId: string, threadTs: string, text: string): Promise<void> {\n"
        "  try {\n"
        "    await app.client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text })\n"
        "  } catch (err) {\n"
        "    logger.error('thread_feedback_post_failed', { channelId, threadTs, err: String(err) })\n"
        "  }\n"
        "}\n"
    )
    print('[5/8] feedback/handler.ts — orchestration handler created')

# ── 6. EDIT: src/integrations/framer/client.ts — add getBlogItemContent ───
P = ROOT / 'src/integrations/framer/client.ts'
src = must_read(P)

if 'getBlogItemContent' in src:
    print('[6/8] client.ts already has getBlogItemContent — skipping')
else:
    # Insert immediately after listBlogItems definition. Use a unique anchor:
    # the closing `} ` of listBlogItems' withFramerSession callback.
    anchor = (
        "export async function listBlogItems(tenant: TenantConfig): Promise<BlogItemSummary[]> {\n"
        "  return withFramerSession(tenant, async (fr) => {\n"
        "    const blog = await findBlog(fr)\n"
        "    const { titleId, dateId } = await resolveBlogFieldIds(blog)\n"
        "    const items = await blog.getItems()\n"
        "    return items.map((i: { id: string; slug: string; fieldData: Record<string, { value: unknown }> }) => ({\n"
        "      id:    i.id,\n"
        "      slug:  i.slug,\n"
        "      title: String(i.fieldData[titleId]?.value ?? ''),\n"
        "      date:  String(i.fieldData[dateId]?.value ?? ''),\n"
        "    }))\n"
        "  })\n"
        "}"
    )
    replacement = anchor + (
        "\n\n"
        "// Phase 9b: read full content of one blog item by ID. Used by thread\n"
        "// feedback to pull the current state of a draft for refinement.\n"
        "export interface BlogItemContent {\n"
        "  id:        string\n"
        "  slug:      string\n"
        "  title:     string\n"
        "  content:   string             // HTML formattedText\n"
        "  date?:     string\n"
        "  imageUrl?: string\n"
        "}\n"
        "\n"
        "export async function getBlogItemContent(\n"
        "  tenant: TenantConfig,\n"
        "  itemId: string,\n"
        "): Promise<BlogItemContent> {\n"
        "  return withFramerSession(tenant, async (fr) => {\n"
        "    const blog = await findBlog(fr)\n"
        "    const { titleId, dateId, contentId, imageId } = await resolveBlogFieldIds(blog)\n"
        "    const items = await blog.getItems()\n"
        "    const item = items.find((i: { id: string }) => i.id === itemId)\n"
        "    if (!item) throw new Error(`Blog item ${itemId} not found`)\n"
        "    const fd = (item as { fieldData: Record<string, { value: unknown }> }).fieldData\n"
        "    return {\n"
        "      id:       item.id,\n"
        "      slug:     (item as { slug: string }).slug,\n"
        "      title:    String(fd[titleId]?.value ?? ''),\n"
        "      content:  String(fd[contentId]?.value ?? ''),\n"
        "      date:     String(fd[dateId]?.value ?? ''),\n"
        "      imageUrl: imageId ? (fd[imageId]?.value as string | undefined) : undefined,\n"
        "    }\n"
        "  })\n"
        "}"
    )
    src = replace_one(src, anchor, replacement, 'client.ts getBlogItemContent insertion')
    P.write_text(src)
    print('[6/8] client.ts — getBlogItemContent helper added')

# ── 7. EDIT: src/core/slack/state-store.ts — add findRunByAnchorTs ────────
P = ROOT / 'src/core/slack/state-store.ts'
src = must_read(P)

if 'findRunByAnchorTs' in src:
    print('[7/8] slack state-store already has findRunByAnchorTs — skipping')
else:
    # Append at the end of the file
    src += (
        "\n"
        "/**\n"
        " * Phase 9b: reverse lookup of a run by (channel, anchor_ts). Used by the\n"
        " * thread-message handler — given a Slack message's channel + thread_ts,\n"
        " * find the run anchored there so we can route feedback.\n"
        " *\n"
        " * Returns null if no run is anchored at that ts (i.e. the thread isn't ours).\n"
        " */\n"
        "export async function findRunByAnchorTs(\n"
        "  pool:      Pool,\n"
        "  channelId: string,\n"
        "  anchorTs:  string,\n"
        "): Promise<RunRow | null> {\n"
        "  const res = await pool.query(\n"
        "    `SELECT task_id, tenant_id, channel_id, anchor_ts, state\n"
        "       FROM slack_runs\n"
        "      WHERE channel_id = $1 AND anchor_ts = $2\n"
        "      LIMIT 1`,\n"
        "    [channelId, anchorTs],\n"
        "  )\n"
        "  if (!res.rows.length) return null\n"
        "  const r = res.rows[0]\n"
        "  return {\n"
        "    taskId:    r.task_id,\n"
        "    tenantId:  r.tenant_id,\n"
        "    channelId: r.channel_id,\n"
        "    anchorTs:  r.anchor_ts,\n"
        "    state:     r.state as RunState,\n"
        "  }\n"
        "}\n"
    )
    P.write_text(src)
    print('[7/8] slack state-store — findRunByAnchorTs appended')

# ── 8. EDIT: src/tenants/slackManager.ts — add app.event('message') ──────
P = ROOT / 'src/tenants/slackManager.ts'
src = must_read(P)

if "app.event('message'" in src or 'thread feedback handler' in src.lower():
    print('[8/8] slackManager already has message handler — skipping')
else:
    # Add imports first
    src = replace_one(
        src,
        "import { registerHitlActionHandlers } from '../hitl'",
        "import { registerHitlActionHandlers } from '../hitl'\n"
        "import { pool } from '../memory/postgres'\n"
        "import { findRunByAnchorTs } from '../core/slack/state-store'\n"
        "import { handleThreadFeedback } from '../feedback/handler'",
        'slackManager.ts imports',
    )
    # Insert the message handler immediately before the `/agent` command block
    src = replace_one(
        src,
        "  // ── /agent command ───────────────────────────────────────────────────────",
        "  // ── Phase 9b: thread reply → pitch refinement ──────────────────────────\n"
        "  //\n"
        "  // When the operator types a message in a thread anchored on one of our\n"
        "  // runs, route it through the refinement handler. Bot messages and direct\n"
        "  // @-mentions are filtered out so we don't react to ourselves or trigger\n"
        "  // double-processing.\n"
        "  app.event('message', async ({ event }) => {\n"
        "    const e = event as {\n"
        "      type:       string\n"
        "      channel?:   string\n"
        "      user?:      string\n"
        "      text?:      string\n"
        "      ts?:        string\n"
        "      thread_ts?: string\n"
        "      subtype?:   string\n"
        "      bot_id?:    string\n"
        "    }\n"
        "    // Filter: only thread replies. Top-level messages and bot messages skip.\n"
        "    if (!e.thread_ts || e.thread_ts === e.ts) return\n"
        "    if (e.subtype === 'bot_message' || e.bot_id) return\n"
        "    if (!e.channel || !e.user || !e.text) return\n"
        "    // Filter: @-mentions are handled by app_mention — don't double-process.\n"
        "    if (e.text.match(/<@[A-Z0-9]+>/)) return\n"
        "    // Filter: thread anchor must belong to one of our runs.\n"
        "    const run = await findRunByAnchorTs(pool, e.channel, e.thread_ts)\n"
        "    if (!run || run.tenantId !== tenant.tenantId) return\n"
        "\n"
        "    try {\n"
        "      await handleThreadFeedback({\n"
        "        app,\n"
        "        tenantId:  tenant.tenantId,\n"
        "        taskId:    run.taskId,\n"
        "        channelId: e.channel,\n"
        "        threadTs:  e.thread_ts,\n"
        "        feedback:  e.text,\n"
        "        userId:    e.user,\n"
        "      })\n"
        "    } catch (err) {\n"
        "      logger.error('thread_feedback_handler_failed', {\n"
        "        tenantId: tenant.tenantId,\n"
        "        taskId:   run.taskId,\n"
        "        err:      String(err).slice(0, 500),\n"
        "      })\n"
        "    }\n"
        "  })\n"
        "\n"
        "  // ── /agent command ───────────────────────────────────────────────────────",
        'slackManager.ts message handler insertion',
    )
    P.write_text(src)
    print('[8/8] slackManager.ts — message handler installed')

print('\nDone. Run:')
print('  npx tsc --noEmit && echo OK')
print('to verify, then commit + push.')
print('')
print('IMPORTANT — Slack app dashboard config (after deploy):')
print('  1. https://api.slack.com/apps/<your-app-id>/oauth')
print('     Add Bot Token Scopes: channels:history, groups:history')
print('  2. https://api.slack.com/apps/<your-app-id>/event-subscriptions')
print('     Subscribe to bot events: message.channels, message.groups')
print('  3. Reinstall the app (button at top of OAuth page after scope changes)')
print('  4. Confirm the bot is a member of the channel where you trigger runs')
print('  Without these scopes, app.event(message) never fires and refinement silently no-ops.')
