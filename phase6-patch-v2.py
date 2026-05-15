#!/usr/bin/env python3
"""
phase6-patch-v2.py — implements the new executor design + Slack preview fix.

Written against the actual codebase state from the GitHub zip (post-Phase-5).

Changes (idempotent — re-run is safe):
  1. src/integrations/framer/client.ts     — append createAndPublishBlogPost
  2. src/integrations/framer/executor.ts   — append two new executors
  3. src/execution/dispatcher.ts           — register two new tool_names
  4. src/skills/seo/tools.ts               — rewrite propose_action description
                                              + propose_action also auto-derives
                                                a content preview into riskReason
                                                for create_and_publish cards
  5. src/agents/subagent.ts                — update prompt paragraphs (daily-gen)
  6. src/core/slack/render.ts              — add inferActionKind cases for
                                              the two new tool names
"""
from __future__ import annotations
import os, sys, re
from pathlib import Path

ROOT = Path.cwd()
assert (ROOT / 'package.json').exists() and (ROOT / 'src').exists(), (
    'Run this from the agent-shell-v3 project root.'
)

def must_read(p: Path) -> str:
    if not p.exists():
        sys.exit(f'fatal: expected file does not exist: {p}')
    return p.read_text()

def must_replace_once(text: str, anchor: str, new: str, where: str) -> str:
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n--- anchor ---\n{anchor[:600]}\n--- end anchor ---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── 1. client.ts — append createAndPublishBlogPost ──────────────────────────
P = ROOT / 'src/integrations/framer/client.ts'
src = must_read(P)
if 'export async function createAndPublishBlogPost' in src:
    print(f'[1/6] client.ts already has createAndPublishBlogPost — skipping')
else:
    src = src.rstrip() + '''

// ── Atomic create + publish for a new blog post ─────────────────────────────
//
// Combines draftAndPreviewBlogPost (creates CMS item + gets confirmationHash)
// with confirmPublish (commits the publish). Used by the
// framer_create_and_publish_blog_post executor on approval.
//
// On failure between create and publish, the freshly-created item is rolled back
// so we don't leave orphan drafts in the Blog collection.

export interface CreateAndPublishResult {
  itemId:        string
  slug:          string
  productionUrl: string
  publishedAt:   string
}

export async function createAndPublishBlogPost(
  tenant: TenantConfig,
  input:  { slug: string; title: string; content: string; imageUrl?: string },
): Promise<CreateAndPublishResult> {
  const draft = await draftAndPreviewBlogPost(tenant, {
    slug:    input.slug,
    title:   input.title,
    content: input.content,
  })
  let publish: ConfirmPublishResult
  try {
    publish = await confirmPublish(tenant, draft.preview.confirmationHash)
  } catch (err) {
    // Best-effort rollback so an interrupted publish doesn't leave cruft behind.
    try { await removeBlogPost(tenant, draft.itemId) } catch { /* swallow */ }
    throw err
  }
  const host = publish.hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname
            ?? (() => {
                 try { return new URL(tenant.framer_project_url ?? '').hostname.replace(/^www\\./, '') }
                 catch { return undefined }
               })()
  return {
    itemId:        draft.itemId,
    slug:          input.slug,
    productionUrl: host ? `https://${host}/blog/${input.slug}` : `/blog/${input.slug}`,
    publishedAt:   new Date().toISOString(),
  }
}
'''
    P.write_text(src + '\n')
    print(f'[1/6] client.ts — appended createAndPublishBlogPost')

# ── 2. executor.ts — append two new executors ───────────────────────────────
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)
if 'execFramerCreateAndPublishBlogPost' in src:
    print(f'[2/6] executor.ts already has new executors — skipping')
else:
    src = src.rstrip() + '''

// ── framer_create_and_publish_blog_post ─────────────────────────────────────
//
// Atomic create + publish path. Filed via propose_action with the FULL post
// content inline in toolInput. The approval card lets the operator review the
// content before publishing. On approve, this executor creates the CMS item
// AND publishes the site in one atomic operation — no orphan drafts on reject.

export interface CreateAndPublishBlogPostInput {
  slug:      string
  title:     string
  content:   string
  imageUrl?: string
}

export async function execFramerCreateAndPublishBlogPost(
  input: CreateAndPublishBlogPostInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.slug || !input.title || !input.content) {
      return { ok: false, summary: 'slug, title, and content are required', error: 'missing required fields' }
    }
    const result = await fr.createAndPublishBlogPost(ctx.tenant, input)
    logger.info('exec_framer_create_and_publish_blog_post', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      itemId:     result.itemId,
      slug:       result.slug,
    })
    return {
      ok:      true,
      summary: `Published "${input.title}" at ${result.productionUrl}`,
      detail:  {
        itemId:        result.itemId,
        slug:          result.slug,
        productionUrl: result.productionUrl,
        publishedAt:   result.publishedAt,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: 'Failed to create + publish blog post',
      error:   String(err).slice(0, 500),
    }
  }
}

// ── manual_operator_task ────────────────────────────────────────────────────
//
// For work the operator does manually (schema markup pastes, internal linking
// edits, copy tweaks). On approve, the executor records acknowledgement; the
// actual change is the operator's manual action in Framer's editor afterwards.

export interface ManualOperatorTaskInput {
  instruction: string
  category?:   string
}

export async function execManualOperatorTask(
  input: ManualOperatorTaskInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.instruction) {
      return { ok: false, summary: 'instruction is required', error: 'missing instruction' }
    }
    logger.info('exec_manual_operator_task', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      category:   input.category ?? 'unspecified',
    })
    return {
      ok:      true,
      summary: input.category
        ? `Acknowledged manual task (${input.category})`
        : 'Acknowledged manual operator task',
      detail:  {
        acknowledgedAt: new Date().toISOString(),
        category:       input.category ?? null,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: 'Failed to record manual task acknowledgement',
      error:   String(err).slice(0, 500),
    }
  }
}
'''
    P.write_text(src + '\n')
    print(f'[2/6] executor.ts — appended execFramerCreateAndPublishBlogPost + execManualOperatorTask')

# ── 3. dispatcher.ts — register two new handlers ────────────────────────────
P = ROOT / 'src/execution/dispatcher.ts'
src = must_read(P)
if "'framer_create_and_publish_blog_post'" in src:
    print(f'[3/6] dispatcher.ts already registers new handlers — skipping')
else:
    # Update import block
    old_imports = (
        "import {\n"
        "  execFramerConfirmPublish,\n"
        "  execFramerRollbackDraft,\n"
        "} from '../integrations/framer/executor'"
    )
    new_imports = (
        "import {\n"
        "  execFramerConfirmPublish,\n"
        "  execFramerRollbackDraft,\n"
        "  execFramerCreateAndPublishBlogPost,\n"
        "  execManualOperatorTask,\n"
        "} from '../integrations/framer/executor'"
    )
    src = must_replace_once(src, old_imports, new_imports, 'dispatcher.ts imports')

    # Add new HANDLERS entries right after the existing framer_rollback_draft line
    rollback_line = "  'framer_rollback_draft':     (i, c) => execFramerRollbackDraft(i as unknown as Parameters<typeof execFramerRollbackDraft>[0], c),"
    new_lines = (
        "  'framer_rollback_draft':     (i, c) => execFramerRollbackDraft(i as unknown as Parameters<typeof execFramerRollbackDraft>[0], c),\n"
        "\n"
        "  // Atomic create + publish — agent files this directly via propose_action\n"
        "  // with FULL content in toolInput. On approve: create CMS item + publish in one shot.\n"
        "  // On reject: no-op (nothing was created yet).\n"
        "  'framer_create_and_publish_blog_post': (i, c) =>\n"
        "    execFramerCreateAndPublishBlogPost(i as unknown as Parameters<typeof execFramerCreateAndPublishBlogPost>[0], c),\n"
        "\n"
        "  // Manual operator task — for schema markup, internal linking, copy edits.\n"
        "  // The agent describes what needs doing; the operator does it manually in Framer.\n"
        "  'manual_operator_task':      (i, c) =>\n"
        "    execManualOperatorTask(i as unknown as Parameters<typeof execManualOperatorTask>[0], c),"
    )
    src = must_replace_once(src, rollback_line, new_lines, 'dispatcher.ts HANDLERS map')
    P.write_text(src)
    print(f'[3/6] dispatcher.ts — registered framer_create_and_publish_blog_post + manual_operator_task')

# ── 4. tools.ts — rewrite propose_action description + add content preview ──
P = ROOT / 'src/skills/seo/tools.ts'
src = must_read(P)
if 'framer_create_and_publish_blog_post' in src:
    print(f'[4/6] tools.ts propose_action already updated — skipping')
else:
    # Replace the entire description string of the propose_action tool. We
    # anchor on the precise lines from the actual file.
    old_desc = (
        '"Create a HITL approval request for any action that touches the public site or sends external " +\n'
        '      "messages. DOES NOT execute — only files the request. " +\n'
        '      "When the action is a Framer blog post you\'ve already drafted via framer_draft_blog_post, the " +\n'
        '      "tool\'s response includes a `next_step` string — it tells you exactly what toolName and " +\n'
        '      "toolInput to pass here. Copy them verbatim.\\n\\n" +\n'
        '      "REQUIRED toolInput shapes for known toolNames (the executor will reject malformed input):\\n\\n" +\n'
        '      "  • framer_confirm_publish — { confirmationHash: <string>, itemId: <string>, slug: <string>, " +\n'
        '      "title: <string> }. Publishes a previewed blog post to production (tarino.au). The " +\n'
        '      "confirmationHash and itemId come from a prior framer_draft_blog_post call. slug and title are " +\n'
        '      "for the approval card display.\\n\\n" +\n'
        '      "  • framer_rollback_draft — { itemId: <string>, slug?: <string> }. Removes a draft CMS " +\n'
        '      "item from Framer. Use when a draft will not be published (operator rejected, dupe slug " +\n'
        '      "discovered, etc.).\\n\\n" +\n'
        '      "If you\'re unsure of the shape, look up the corresponding integration tool\'s input_schema for " +\n'
        '      "guidance — propose_action\'s toolInput is forwarded verbatim to the executor."'
    )
    new_desc = (
        '"Create a HITL approval request for any action that touches the public site or sends external " +\n'
        '      "messages. Files the request — does NOT execute. The executor runs only after operator approval.\\n\\n" +\n'
        '      "You MUST set toolName to ONE of these registered executor names:\\n\\n" +\n'
        '      "  • framer_create_and_publish_blog_post — atomic create + publish of a NEW blog post on the Framer Blog. " +\n'
        '      "toolInput = { slug: <kebab-case string, becomes /blog/<slug>>, title: <string>, content: <HTML in Framer formattedText: <p dir=\\"auto\\">…</p>, <h2>, <strong>, <ul><li>, etc.>, imageUrl?: <optional hero image URL> }. " +\n'
        '      "Put the FULL post content in toolInput.content — no need to call framer_draft_blog_post first. " +\n'
        '      "On approve: executor creates the CMS item AND publishes the site in one atomic operation. " +\n'
        '      "On reject: no-op (nothing was created). " +\n'
        '      "Set previewUrl to https://tarino.au/blog/<slug> for the post-publish link (the operator clicks it after approving).\\n\\n" +\n'
        '      "  • manual_operator_task — for changes Framer\'s Server API can\'t do programmatically. " +\n'
        '      "Use this for schema markup pastes, internal linking edits, copy changes on existing pages, page-level SEO meta edits, new landing pages. " +\n'
        '      "toolInput = { instruction: <full step-by-step instructions including any JSON-LD / HTML / anchor-text strings the operator needs to paste, verbatim>, category?: <\'schema\' | \'linking\' | \'copy\' | \'meta\' | \'new-page\'> }. " +\n'
        '      "On approve: executor records acknowledgement. The actual change happens by the operator\'s hand in Framer\'s editor.\\n\\n" +\n'
        '      "  • framer_confirm_publish / framer_rollback_draft — LEGACY two-phase commit. Use ONLY if you have a confirmationHash from a prior framer_draft_blog_post call. " +\n'
        '      "For all NEW work, prefer framer_create_and_publish_blog_post.\\n\\n" +\n'
        '      "CRITICAL: toolName MUST be one of the four values listed above. Do NOT use the name of any agent-callable research tool " +\n'
        '      "(framer_draft_blog_post, framer_list_blog_items, framer_get_changed_paths, analyze_page, dataforseo_*, etc.). " +\n'
        '      "Those are not registered executors — the approval button will be a dead button if you do."'
    )
    src = must_replace_once(src, old_desc, new_desc, 'tools.ts propose_action description')

    # Also: enrich riskReason with a content preview when toolName matches the
    # new create+publish executor. This makes the Slack card show the actual
    # post content the operator is about to publish, without needing a preview URL.
    # We inject this just BEFORE the createApproval call so it applies to both
    # PG and Slack writes.
    inject_anchor = "  // 1. Write to PG (operational state — required, agent polls this)"
    inject_block = (
        "  // Phase 6: enrich whyPriority with a content preview for create-and-publish\n"
        "  // approvals, so the Slack card shows what's about to be published.\n"
        "  if (i.toolName === 'framer_create_and_publish_blog_post') {\n"
        "    const ti = i.toolInput as { title?: string; content?: string; slug?: string };\n"
        "    const stripped = (ti.content ?? '').replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();\n"
        "    const excerpt = stripped.length > 600 ? stripped.slice(0, 600) + '…' : stripped;\n"
        "    const wordCount = stripped.split(/\\s+/).filter(Boolean).length;\n"
        "    const meta = `*Draft preview — ${wordCount} words.*  Slug: \\`${ti.slug ?? '(missing)'}\\``;\n"
        "    i.whyPriority = `${i.whyPriority ?? ''}\\n\\n${meta}\\n\\n${excerpt}`.trim();\n"
        "  }\n"
        "  if (i.toolName === 'manual_operator_task') {\n"
        "    const ti = i.toolInput as { instruction?: string; category?: string };\n"
        "    const instr = (ti.instruction ?? '').slice(0, 1500);\n"
        "    const cat = ti.category ? ` [${ti.category}]` : '';\n"
        "    i.whyPriority = `${i.whyPriority ?? ''}\\n\\n*Operator task${cat}:*\\n\\n${instr}`.trim();\n"
        "  }\n\n"
        "  // 1. Write to PG (operational state — required, agent polls this)"
    )
    src = must_replace_once(src, inject_anchor, inject_block, 'tools.ts whyPriority enrichment')

    P.write_text(src)
    print(f'[4/6] tools.ts — rewrote propose_action description + added content-preview enrichment')

# ── 5. subagent.ts — update daily-generation prompt paragraphs ──────────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
if 'framer_create_and_publish_blog_post' in src:
    print(f'[5/6] subagent.ts already references new executor — skipping')
else:
    # Replace the "New blog posts" paragraph
    old_blog = (
        '**New blog posts.** What is ${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. If you spot a clear winner, draft it as a blog post via framer_draft_blog_post (creates the CMS item AND runs the publish preview in one call). Then file propose_action using the next_step string the tool returns. NEW LANDING PAGES are NOT yet supported by the Framer API surface — if a gap genuinely calls for a new page (not a blog post), log it as a seo_opportunities entry with the proposed page outline and let the operator build it in Framer\'s UI.'
    )
    new_blog = (
        '**New blog posts.** What is ${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. If you spot a clear winner, write the post and file it directly via propose_action with toolName=\'framer_create_and_publish_blog_post\' — toolInput holds the full content inline ({ slug, title, content, imageUrl? }). The executor creates the CMS item AND publishes on operator approval, in one atomic step. Nothing is created in Framer until approval — clean reject = no cleanup needed. For NEW LANDING PAGES (not blog posts), the Framer Server API can\'t create them programmatically — propose_action with toolName=\'manual_operator_task\' instead, giving the operator the page outline + a list of pages to add to nav etc.'
    )
    src = must_replace_once(src, old_blog, new_blog, 'subagent.ts New blog posts paragraph')

    # Replace the "Internal links" paragraph
    old_links = (
        '**Internal links between existing pages.** Two pages that obviously belong linked but aren\'t. The Framer Server API can\'t edit existing page content programmatically today, so log these as seo_opportunities (log_opportunity) with the specific source page, target page, and proposed anchor text. The operator implements them in Framer\'s UI directly.'
    )
    new_links = (
        '**Internal links between existing pages.** Two pages that obviously belong linked but aren\'t. The Framer Server API can\'t edit existing page content programmatically today, so file these via propose_action with toolName=\'manual_operator_task\' and toolInput={ instruction: <source page + target page + exact anchor text + where to place the link>, category: \'linking\' }. The operator does the actual edit in Framer\'s UI.'
    )
    src = must_replace_once(src, old_links, new_links, 'subagent.ts Internal links paragraph')

    # Replace the "Additive copy" paragraph
    old_copy = (
        '**Additive copy or meta on existing pages.** Same constraint as internal links: no programmatic page edits via the current Framer API surface. Log specific proposals to seo_opportunities (with the exact copy, the placement, and the why) for operator-driven implementation. New FAQ sections, expanded meta descriptions, additional paragraphs that close a gap — all valuable; just not agent-shippable yet.'
    )
    new_copy = (
        '**Additive copy or meta on existing pages.** Same constraint as internal links: no programmatic page edits. File these via propose_action with toolName=\'manual_operator_task\' and toolInput={ instruction: <the exact copy + the page + where on the page>, category: \'copy\' or \'meta\' }. New FAQ sections, expanded meta descriptions, additional paragraphs — all valuable and now ship through the same approval workflow as blog posts, just acknowledged-on-approve rather than auto-published.'
    )
    src = must_replace_once(src, old_copy, new_copy, 'subagent.ts Additive copy paragraph')

    # Replace the "On Framer blog posts" section
    old_section = '''## On Framer blog posts

To propose a new blog post:

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes with your post.
2. Call framer_list_blog_items to confirm your proposed slug is unique and to study the existing post style and topic mix.
3. Call framer_draft_blog_post with { slug, title, content }. Content is HTML in Framer's formattedText format (<p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.). The tool creates the CMS item AND runs the publish preview in one shot.
4. The response includes a "next_step" string — it tells you exactly what to put in propose_action. Copy the toolName and toolInput verbatim.
5. On approval, the post goes live at https://tarino.au/blog/<slug>. On rejection (or if the operator never decides), the draft sits as an unpublished CMS item in Framer. framer_rollback_draft can clean it up later if needed.

NOT supported by the current Framer API surface: editing existing pages, changing SEO meta on pages, creating new landing pages. For those, log a seo_opportunities entry with the specific proposal and let the operator implement in Framer's UI.'''

    new_section = '''## On Framer blog posts

To propose a new blog post (RECOMMENDED — atomic create + publish, no orphan drafts):

1. Call framer_get_changed_paths first. If it shows any pending changes in the workspace, STOP — surface the situation to the operator rather than proceeding. Publishing would bundle those changes with your post.
2. Call framer_list_blog_items to confirm your proposed slug is unique and to study the existing post style and topic mix.
3. Write the post in full — title + slug + content (HTML in Framer's formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.).
4. File propose_action directly with:
     toolName  = 'framer_create_and_publish_blog_post'
     toolInput = { slug, title, content, imageUrl? }
     proposedAction = one-line plain-English summary for the Slack card
     priority = P0/P1/P2/P3
     previewUrl = `https://tarino.au/blog/<slug>` (post-publish link)

On approval: the executor creates the CMS item AND publishes the site in one atomic operation. The post goes live at https://tarino.au/blog/<slug> within seconds.
On rejection: nothing is created. No cleanup needed.

Note: do NOT call framer_draft_blog_post for new posts — that's the legacy two-phase path. The new atomic path is cleaner because the operator approves CONTENT (not just a publish), and rejection leaves no cruft in the Blog collection.

For changes Framer's API can't do programmatically — editing existing pages, SEO meta on pages, internal linking, schema markup, new landing pages — use propose_action with toolName='manual_operator_task'. The instruction field should be detailed enough that the operator can do the work in Framer's editor without further input from you. Include verbatim code blocks for schema, exact anchor text + source/target pages for linking, full revised copy for content tweaks.'''

    src = must_replace_once(src, old_section, new_section, 'subagent.ts On Framer blog posts section')

    P.write_text(src)
    print(f'[5/6] subagent.ts — rewrote daily-gen prompt sections for the new executor design')

# ── 6. render.ts — update inferActionKind ────────────────────────────────────
P = ROOT / 'src/core/slack/render.ts'
src = must_read(P)
if "'framer_create_and_publish_blog_post'" in src:
    print(f'[6/6] render.ts already updated — skipping')
else:
    old_fn = '''function inferActionKind(toolName: string): import('./blocks/approval').ApprovalActionKind {
  const n = toolName.toLowerCase()
  // Framer (two-phase blog publish via framer_draft_blog_post + framer_confirm_publish)
  if (n.startsWith('framer_confirm_publish')) return 'publish_content'
  if (n.startsWith('framer_rollback_draft'))  return 'commit_data_change'
  if (n.startsWith('framer_'))                return 'modify_live_page'
  if (n.startsWith('gsc_submit') || n.startsWith('gsc_request')) return 'publish_content'
  // Outreach-type
  if (n.startsWith('email_') || n.startsWith('send_') || n.startsWith('slack_post'))
    return 'send_external_message'
  // Internal data writes
  if (n.startsWith('log_') || n.startsWith('upsert_') || n.startsWith('snapshot_'))
    return 'commit_data_change'
  return 'other'
}'''
    new_fn = '''function inferActionKind(toolName: string): import('./blocks/approval').ApprovalActionKind {
  const n = toolName.toLowerCase()
  // Phase 6: atomic create + publish path is the primary blog-post executor.
  if (n === 'framer_create_and_publish_blog_post') return 'publish_content'
  // Phase 6: manual operator tasks (schema, linking, copy edits) — operator does
  // the actual change in Framer; on approve the executor just acknowledges.
  if (n === 'manual_operator_task')                return 'modify_live_page'
  // Legacy two-phase blog publish (kept for backwards compat).
  if (n.startsWith('framer_confirm_publish')) return 'publish_content'
  if (n.startsWith('framer_rollback_draft'))  return 'commit_data_change'
  if (n.startsWith('framer_'))                return 'modify_live_page'
  if (n.startsWith('gsc_submit') || n.startsWith('gsc_request')) return 'publish_content'
  // Outreach-type
  if (n.startsWith('email_') || n.startsWith('send_') || n.startsWith('slack_post'))
    return 'send_external_message'
  // Internal data writes
  if (n.startsWith('log_') || n.startsWith('upsert_') || n.startsWith('snapshot_'))
    return 'commit_data_change'
  return 'other'
}'''
    src = must_replace_once(src, old_fn, new_fn, 'render.ts inferActionKind')
    P.write_text(src)
    print(f'[6/6] render.ts — added inferActionKind cases for the two new tool names')

print('')
print('All phase6 patches applied. Run:')
print('  npx tsc --noEmit')
print('to verify nothing broke. If clean: commit + push to deploy.')
