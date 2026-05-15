#!/usr/bin/env python3
"""
phase6-patch-v3.py — same as v2 but with the backtick bug in subagent.ts fixed.

Re-run after `git checkout src/agents/subagent.ts`. v2's other steps were already
applied and are still good — the idempotency checks will skip them. Only step 5
will do meaningful work.
"""
from __future__ import annotations
import sys, re
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

# ── 1-4, 6: idempotent — skip if already applied ────────────────────────────
# Only check, don't re-do.
checks = [
    ('src/integrations/framer/client.ts',   'export async function createAndPublishBlogPost'),
    ('src/integrations/framer/executor.ts', 'execFramerCreateAndPublishBlogPost'),
    ('src/execution/dispatcher.ts',         "'framer_create_and_publish_blog_post'"),
    ('src/skills/seo/tools.ts',             'framer_create_and_publish_blog_post'),
    ('src/core/slack/render.ts',            "'framer_create_and_publish_blog_post'"),
]
for path, marker in checks:
    p = ROOT / path
    if not p.exists():
        sys.exit(f'fatal: {path} missing')
    if marker not in p.read_text():
        sys.exit(f'fatal: {path} appears NOT to have v2 patches applied. '
                 f'Run the full v2 first, or check the file manually.')
print('[1-4, 6/6] previously patched files have markers — skipping (all good)')

# ── 5. subagent.ts — re-apply with backticks scrubbed ───────────────────────
P = ROOT / 'src/agents/subagent.ts'
src = must_read(P)
if 'framer_create_and_publish_blog_post' in src:
    sys.exit('fatal: subagent.ts still contains the broken Phase-6 text. '
             'Run `git checkout src/agents/subagent.ts` first, then re-run this script.')

# Replace the "New blog posts" paragraph
old_blog = (
    '**New blog posts.** What is ${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. If you spot a clear winner, draft it as a blog post via framer_draft_blog_post (creates the CMS item AND runs the publish preview in one call). Then file propose_action using the next_step string the tool returns. NEW LANDING PAGES are NOT yet supported by the Framer API surface — if a gap genuinely calls for a new page (not a blog post), log it as a seo_opportunities entry with the proposed page outline and let the operator build it in Framer\'s UI.'
)
new_blog = (
    "**New blog posts.** What is ${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. If you spot a clear winner, write the post and file it directly via propose_action with toolName='framer_create_and_publish_blog_post' — toolInput holds the full content inline ({ slug, title, content, imageUrl? }). The executor creates the CMS item AND publishes on operator approval, in one atomic step. Nothing is created in Framer until approval — clean reject = no cleanup needed. For NEW LANDING PAGES (not blog posts), the Framer Server API can't create them programmatically — propose_action with toolName='manual_operator_task' instead, giving the operator the page outline + a list of pages to add to nav etc."
)
src = must_replace_once(src, old_blog, new_blog, 'subagent.ts New blog posts paragraph')

old_links = (
    '**Internal links between existing pages.** Two pages that obviously belong linked but aren\'t. The Framer Server API can\'t edit existing page content programmatically today, so log these as seo_opportunities (log_opportunity) with the specific source page, target page, and proposed anchor text. The operator implements them in Framer\'s UI directly.'
)
new_links = (
    "**Internal links between existing pages.** Two pages that obviously belong linked but aren't. The Framer Server API can't edit existing page content programmatically today, so file these via propose_action with toolName='manual_operator_task' and toolInput={ instruction: <source page + target page + exact anchor text + where to place the link>, category: 'linking' }. The operator does the actual edit in Framer's UI."
)
src = must_replace_once(src, old_links, new_links, 'subagent.ts Internal links paragraph')

old_copy = (
    '**Additive copy or meta on existing pages.** Same constraint as internal links: no programmatic page edits via the current Framer API surface. Log specific proposals to seo_opportunities (with the exact copy, the placement, and the why) for operator-driven implementation. New FAQ sections, expanded meta descriptions, additional paragraphs that close a gap — all valuable; just not agent-shippable yet.'
)
new_copy = (
    "**Additive copy or meta on existing pages.** Same constraint as internal links: no programmatic page edits. File these via propose_action with toolName='manual_operator_task' and toolInput={ instruction: <the exact copy + the page + where on the page>, category: 'copy' or 'meta' }. New FAQ sections, expanded meta descriptions, additional paragraphs — all valuable and now ship through the same approval workflow as blog posts, just acknowledged-on-approve rather than auto-published."
)
src = must_replace_once(src, old_copy, new_copy, 'subagent.ts Additive copy paragraph')

# The Framer-blog-posts section — backticks scrubbed, use plain prose
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
3. Write the post in full — title + slug + content (HTML in Framer\'s formattedText format: <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.).
4. File propose_action directly with:
     toolName       = "framer_create_and_publish_blog_post"
     toolInput      = { slug, title, content, imageUrl? }
     proposedAction = one-line plain-English summary for the Slack card
     priority       = P0 / P1 / P2 / P3
     previewUrl     = the post-publish URL the operator can visit after approving (https://tarino.au/blog/ followed by the slug)

On approval: the executor creates the CMS item AND publishes the site in one atomic operation. The post goes live at https://tarino.au/blog/(slug) within seconds.
On rejection: nothing is created. No cleanup needed.

Note: do NOT call framer_draft_blog_post for new posts — that\'s the legacy two-phase path. The new atomic path is cleaner because the operator approves CONTENT (not just a publish), and rejection leaves no cruft in the Blog collection.

For changes Framer\'s API can\'t do programmatically — editing existing pages, SEO meta on pages, internal linking, schema markup, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer\'s editor without further input from you. Include verbatim code blocks for schema, exact anchor text + source/target pages for linking, full revised copy for content tweaks.'''

src = must_replace_once(src, old_section, new_section, 'subagent.ts On Framer blog posts section')

P.write_text(src)
print('[5/6] subagent.ts — re-applied prompt patches with backticks scrubbed')

print('')
print('Done. Run:')
print('  npx tsc --noEmit')
print('to verify.')
