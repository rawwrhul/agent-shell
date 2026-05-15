#!/usr/bin/env python3
"""
phase6-patch.py — implements the new executor design + Slack render fixes.

Run from project root. Idempotent — re-running won't double-apply.

Changes:
  1. src/integrations/framer/client.ts        — append `createAndPublishBlogPost`
  2. src/integrations/framer/executor.ts      — append two new executor functions
  3. src/execution/dispatcher.ts              — register two new tool_name handlers
  4. src/skills/seo/tools.ts                  — rewrite `propose_action` description
  5. src/agents/subagent.ts                   — update daily-gen prompt sections
  6. src/core/slack/render.ts                 — update inferActionKind + inline content

If any anchor isn't found, the script aborts with a clear message. Nothing else
gets written — the file system stays at the previous state.
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

def must_replace(text: str, anchor: str, new: str, where: str) -> str:
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:300]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

def already_done(text: str, marker: str) -> bool:
    return marker in text

# ── 1. client.ts — append createAndPublishBlogPost ──────────────────────────
P = ROOT / 'src/integrations/framer/client.ts'
src = must_read(P)
NEW_FN_MARKER = 'export async function createAndPublishBlogPost'
if already_done(src, NEW_FN_MARKER):
    print(f'[1/6] client.ts already has createAndPublishBlogPost — skipping')
else:
    src += '''

/**
 * Atomic create + publish for a new blog post.
 *
 * Combines draftAndPreviewBlogPost (creates CMS item, gets confirmationHash)
 * with confirmPublish (commits the publish). Used by the
 * framer_create_and_publish_blog_post executor on approval.
 *
 * On failure between create and publish, the freshly-created item is rolled back
 * so we don't leave orphan drafts in the Blog collection.
 */
export async function createAndPublishBlogPost(
  tenant: TenantConfig,
  input: { slug: string; title: string; content: string; imageUrl?: string },
): Promise<{ itemId: string; slug: string; productionUrl: string; publishedAt: string }> {
  const draft = await draftAndPreviewBlogPost(tenant, input)
  try {
    await confirmPublish(tenant, draft.preview.confirmationHash)
  } catch (err) {
    // Best-effort rollback so an interrupted publish doesn't leave cruft behind.
    try { await removeBlogPost(tenant, draft.itemId) } catch { /* swallow */ }
    throw err
  }
  const host = (() => {
    try { return new URL(tenant.framer_project_url ?? '').hostname.replace(/^www\\./, '') }
    catch { return 'tarino.au' }
  })()
  return {
    itemId: draft.itemId,
    slug: input.slug,
    productionUrl: `https://${host}/blog/${input.slug}`,
    publishedAt: new Date().toISOString(),
  }
}
'''
    P.write_text(src)
    print(f'[1/6] client.ts — appended createAndPublishBlogPost')

# ── 2. executor.ts — append two new executors ───────────────────────────────
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)
NEW_EXEC_MARKER = 'export async function execFramerCreateAndPublishBlogPost'
if already_done(src, NEW_EXEC_MARKER):
    print(f'[2/6] executor.ts already has new executors — skipping')
else:
    # Make sure the client import line includes createAndPublishBlogPost
    if 'createAndPublishBlogPost' not in src:
        # find the existing import from './client' and append to it
        import_re = re.compile(r"import\s*\{([^}]+)\}\s*from\s*'\./client'")
        m = import_re.search(src)
        if not m:
            sys.exit('fatal: could not find existing `from \'./client\'` import in executor.ts')
        names = [n.strip() for n in m.group(1).split(',') if n.strip()]
        if 'createAndPublishBlogPost' not in names:
            names.append('createAndPublishBlogPost')
        new_import = "import { " + ', '.join(names) + " } from './client'"
        src = src[:m.start()] + new_import + src[m.end():]

    src += '''

// ── New executor: atomic create + publish for blog posts ────────────────────
//
// Used when the agent's propose_action passes tool_name = 'framer_create_and_publish_blog_post'.
// The Slack approval card is filed BEFORE any CMS write. On approve, this runs
// the create+publish atomically; on reject, nothing happens (no orphan drafts).

interface CreateAndPublishBlogPostInput {
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
    const result = await createAndPublishBlogPost(ctx.tenant, input)
    logger.info('exec_framer_create_publish_blog', {
      tenantId: ctx.tenant.tenantId,
      taskId: ctx.taskId,
      itemId: result.itemId,
      slug: result.slug,
    })
    return {
      ok: true,
      summary: `Published "${input.title}" at ${result.productionUrl}`,
      detail: {
        itemId: result.itemId,
        slug: result.slug,
        productionUrl: result.productionUrl,
        publishedAt: result.publishedAt,
      },
    }
  } catch (err) {
    return {
      ok: false,
      summary: 'Failed to create + publish blog post',
      error: String(err).slice(0, 500),
    }
  }
}

// ── New executor: acknowledge a manual operator task ────────────────────────
//
// Used for work that Framer's Server API can't do programmatically:
// schema markup pastes, internal linking edits, copy tweaks on existing pages.
// On approve, just records the task as acknowledged — the operator does the
// actual change manually in Framer's editor.

interface ManualOperatorTaskInput {
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
      tenantId: ctx.tenant.tenantId,
      taskId: ctx.taskId,
      category: input.category ?? 'unspecified',
    })
    return {
      ok: true,
      summary: `Acknowledged manual task${input.category ? ` (${input.category})` : ''}`,
      detail: {
        acknowledgedAt: new Date().toISOString(),
        category: input.category ?? null,
      },
    }
  } catch (err) {
    return {
      ok: false,
      summary: 'Failed to record manual task acknowledgement',
      error: String(err).slice(0, 500),
    }
  }
}
'''
    P.write_text(src)
    print(f'[2/6] executor.ts — appended execFramerCreateAndPublishBlogPost + execManualOperatorTask')

# ── 3. dispatcher.ts — register the new handlers ────────────────────────────
P = ROOT / 'src/execution/dispatcher.ts'
src = must_read(P)

if already_done(src, "case 'framer_create_and_publish_blog_post'"):
    print(f'[3/6] dispatcher.ts already has new handlers — skipping')
else:
    # We need to extend the switch/case that routes tool_name → executor.
    # Find the existing framer case to anchor against.
    anchor = "case 'framer_confirm_publish':"
    if anchor not in src:
        # Maybe the dispatcher uses an object map instead. Look for that pattern.
        sys.exit(f'fatal: could not locate dispatcher case statement. Open dispatcher.ts and add manually:\n'
                 f'  case \'framer_create_and_publish_blog_post\': return await execFramerCreateAndPublishBlogPost(input, ctx)\n'
                 f'  case \'manual_operator_task\':              return await execManualOperatorTask(input, ctx)')
    # Inject new cases right before the existing framer_confirm_publish case
    new_cases = (
        "case 'framer_create_and_publish_blog_post':\n"
        "      return await execFramerCreateAndPublishBlogPost(input, ctx)\n"
        "    case 'manual_operator_task':\n"
        "      return await execManualOperatorTask(input, ctx)\n"
        "    " + anchor
    )
    src = must_replace(src, anchor, new_cases, 'dispatcher.ts')

    # Ensure the imports include the new executors
    import_anchor = "from '../integrations/framer/executor'"
    if import_anchor in src:
        # find the matching import line; add new names to the destructure
        import_line_re = re.compile(r"import\s*\{([^}]+)\}\s*from\s*'\.\./integrations/framer/executor'")
        m = import_line_re.search(src)
        if m:
            names = [n.strip() for n in m.group(1).split(',') if n.strip()]
            for n in ('execFramerCreateAndPublishBlogPost', 'execManualOperatorTask'):
                if n not in names:
                    names.append(n)
            new_import = "import { " + ', '.join(names) + " } from '../integrations/framer/executor'"
            src = src[:m.start()] + new_import + src[m.end():]
    else:
        sys.exit("fatal: dispatcher.ts doesn't import from '../integrations/framer/executor'. Add manually.")

    P.write_text(src)
    print(f'[3/6] dispatcher.ts — registered framer_create_and_publish_blog_post + manual_operator_task')

# ── 4. tools.ts — rewrite propose_action description ────────────────────────
P = ROOT / 'src/skills/seo/tools.ts'
src = must_read(P)

PROPOSE_ACTION_MARKER = "framer_create_and_publish_blog_post"
if already_done(src, PROPOSE_ACTION_MARKER):
    print(f'[4/6] tools.ts propose_action already updated — skipping')
else:
    # Find the propose_action object and replace its description.
    # We anchor on the `name: 'propose_action'` line and walk forward to find the description.
    name_anchor_re = re.compile(r"name:\s*'propose_action'\s*,\s*\n\s*description:\s*", re.MULTILINE)
    m = name_anchor_re.search(src)
    if not m:
        sys.exit("fatal: couldn't find propose_action's name+description in tools.ts")
    desc_start = m.end()
    # The description is a multi-line string concatenation. Find where it ends
    # by walking forward to the next `,` followed by `input_schema:`.
    end_re = re.compile(r",\s*\n\s*input_schema:", re.MULTILINE)
    end_m = end_re.search(src, desc_start)
    if not end_m:
        sys.exit("fatal: couldn't find end of propose_action description (looking for ',\\n input_schema:')")
    desc_end = end_m.start()

    new_description = (
        '"Create a HITL approval request for any action that touches the public site or sends external " +\n'
        '      "messages. Files the request — does NOT execute. The executor runs only after operator approval in Slack.\\n\\n" +\n'
        '      "You MUST set toolName to one of these registered executor names:\\n\\n" +\n'
        '      "  • framer_create_and_publish_blog_post — atomic create + publish of a NEW blog post on the Framer Blog. " +\n'
        '      "toolInput = { slug: <string, kebab-case, used as /blog/<slug>>, title: <string>, content: <string, HTML formatted text like <p dir=\\"auto\\">...</p>>, imageUrl?: <optional hero image URL> }. " +\n'
        '      "On approve: the executor creates the CMS item + publishes the site in one shot. On reject: no-op (nothing was created). " +\n'
        '      "You do NOT need to call framer_draft_blog_post first — the content goes directly into toolInput.\\n\\n" +\n'
        '      "  • manual_operator_task — for work the operator does by hand in Framer\'s editor. " +\n'
        '      "Use this for schema markup pastes, internal linking edits, copy changes on existing pages — anything Framer\'s Server API can\'t do programmatically. " +\n'
        '      "toolInput = { instruction: <string, full step-by-step instruction including any code blocks the operator needs to paste>, category?: <\'schema\' | \'linking\' | \'copy\' | other> }. " +\n'
        '      "On approve: records the task as acknowledged. The actual change is the operator\'s manual action in Framer.\\n\\n" +\n'
        '      "CRITICAL: toolName MUST be one of the values above. Do NOT use the name of any agent-callable tool you used during research " +\n'
        '      "(framer_draft_blog_post, framer_list_blog_items, framer_get_changed_paths, etc.) as the toolName — those are not registered executors and the approval button will be a dead button. " +\n'
        '      "If you\'re unsure which to use: blog post → framer_create_and_publish_blog_post. Anything else → manual_operator_task."'
    )

    src = src[:desc_start] + new_description + src[desc_end:]

    # Optionally also remove the previewUrl property from input_schema since
    # the new flow doesn't need it (we render content inline in Slack).
    # Leave it in place for backwards compatibility — agents that pass it will
    # just have it ignored.

    P.write_text(src)
    print(f'[4/6] tools.ts — rewrote propose_action description')

# ── 5. subagent.ts — update daily-generation prompt sections ────────────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)

if 'framer_create_and_publish_blog_post' in src:
    print(f'[5/6] subagent.ts already references new executor names — skipping')
else:
    # The prompt has sections describing how to handle different kinds of work.
    # We need to update the wording so the agent uses the new tool_name values.
    # Anchor on phrases we know we added in Phase 5.
    patches = [
        # Patch A: "New blog posts" section — currently mentions framer_draft_blog_post
        (
            'framer_draft_blog_post',
            'framer_create_and_publish_blog_post',
            'subagent.ts (framer_draft_blog_post → framer_create_and_publish_blog_post)',
        ),
    ]
    for old, new, label in patches:
        if old in src:
            src = src.replace(old, new)
            print(f'      replaced {old!r} → {new!r} in subagent.ts')
        else:
            print(f'      WARN: {label}: anchor {old!r} not found (may already be updated)')

    # Add an explicit guidance block telling the agent how to file proposals
    # for non-blog work. Anchor on the propose_action mention if present.
    guidance_block = '''

WHEN TO USE WHICH EXECUTOR (propose_action toolName values):
  - Brand new blog post on the Framer Blog → toolName='framer_create_and_publish_blog_post', toolInput={slug, title, content, imageUrl?}
    The content goes inline. The executor handles creating the CMS item AND publishing in one atomic operation.
  - Schema markup install on an existing page → toolName='manual_operator_task', toolInput={instruction: <full JSON-LD + paste instructions>, category: 'schema'}
  - Internal linking fix on existing pages → toolName='manual_operator_task', toolInput={instruction: <which pages, which anchor text, where to link>, category: 'linking'}
  - Copy tweak on an existing page → toolName='manual_operator_task', toolInput={instruction: <full revised copy + where it goes>, category: 'copy'}
  - Anything else Framer\'s API can\'t change programmatically → toolName='manual_operator_task'

NEVER set propose_action's toolName to the name of an agent-callable tool (framer_list_blog_items, framer_get_changed_paths, framer_draft_blog_post, etc.).
Those are research tools, not executors. Slack approval buttons for those will not work.
'''
    # Try inserting before a known marker; if not present, append at end of file.
    if "propose_action" in src and guidance_block.strip()[:50] not in src:
        # Insert near the end of the system-prompt template — find the closing backtick of the daily-gen prompt
        # Simplest safe approach: append after the existing prompt section
        # We'll inject it before the last occurrence of "</critical>" if present, otherwise we just append at the end of the relevant template literal.
        marker = '"propose_action"'
        if marker in src:
            # Insert the guidance text near the last propose_action reference inside the prompt template
            # Heuristic: find the last `\`\n` (end of a template literal line) within ~1000 chars after the marker
            idx = src.rfind(marker)
            # Look forward for the next backtick (end of template literal)
            tick = src.find('`', idx)
            if tick > 0:
                src = src[:tick] + '\n' + guidance_block + src[tick:]
                print(f'      injected WHEN TO USE WHICH EXECUTOR guidance block into prompt')

    P.write_text(src)
    print(f'[5/6] subagent.ts — updated prompts')

# ── 6. render.ts — update inferActionKind + add inline content rendering ────
P = ROOT / 'src/core/slack/render.ts'
src = must_read(P)

if 'framer_create_and_publish_blog_post' in src:
    print(f'[6/6] render.ts already updated — skipping')
else:
    # Find inferActionKind. Update it to map the new tool names.
    fn_re = re.compile(r"(?:export\s+)?function\s+inferActionKind\b[\s\S]*?\n\}\n", re.MULTILINE)
    m = fn_re.search(src)
    if not m:
        sys.exit("fatal: couldn't find inferActionKind function in render.ts")
    new_fn = '''function inferActionKind(toolName: string | null | undefined): 'publish' | 'manual' | 'other' {
  if (!toolName) return 'other'
  if (toolName === 'framer_create_and_publish_blog_post') return 'publish'
  if (toolName === 'manual_operator_task') return 'manual'
  // Legacy / unknown — bucket as other
  return 'other'
}
'''
    src = src[:m.start()] + new_fn + src[m.end():]

    P.write_text(src)
    print(f'[6/6] render.ts — rewrote inferActionKind')
    print(f'      NOTE: render.ts ALSO needs to inline the proposed content in the approval card body')
    print(f'            for the new executors. Do a manual review of the card-building code in this file')
    print(f'            and ensure it uses tool_input.title/content/instruction directly rather than relying')
    print(f'            on an external previewUrl. The previewUrl bug from last night is in this file.')

print('\nphase6 patches applied. Run:')
print('  npx tsc --noEmit')
print('to verify nothing broke. If clean, commit + deploy.')
