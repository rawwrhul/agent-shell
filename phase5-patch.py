#!/usr/bin/env python3
"""
phase5-patch.py

Surgical updates to three files that still reference the old fictional Framer
tool names. Each replacement uses anchored exact-string matching — if the
anchor doesn't match (e.g., your working tree has drifted from the version I
analyzed), the script errors with a clear message rather than corrupting the
file.

Files patched:
  1. src/skills/seo/tools.ts        propose_action description + previewUrl description
  2. src/agents/subagent.ts         daily-generation prompt's Framer paragraphs
  3. src/core/slack/render.ts       inferActionKind tool-name mappings

Run from the agent-shell-v3 project root:
  python3 phase5-patch.py

Originals backed up to *.phase5.bak before any change. After verifying with
`git diff`, remove the .bak files.
"""

import os
import sys
import shutil

# -----------------------------------------------------------------------------
# Patches
# -----------------------------------------------------------------------------

PATCHES = []

# --- 1. src/skills/seo/tools.ts: propose_action description ------------------

PATCHES.append({
    "file": "src/skills/seo/tools.ts",
    "label": "propose_action description",
    "old": (
        '"Create a HITL approval request for any action that touches the public site or sends external " +\n'
        '      "messages. DOES NOT execute \u2014 only files the request. " +\n'
        '      "When the action is a Framer page change you\'ve already drafted via framer_create_draft_page or " +\n'
        '      "framer_update_page_draft, pass the previewUrl through \u2014 the Slack approval card renders it as a " +\n'
        '      "\'View preview \u2197\' link the operator can click before approving.\\n\\n" +\n'
        '      "REQUIRED toolInput shapes for known toolNames (the executor will reject malformed input):\\n\\n" +\n'
        '      "  \u2022 framer_update_page_seo \u2014 { pageId: <string>, title?: <string>, description?: <string>, " +\n'
        '      "ogTitle?: <string>, ogDescription?: <string>, ogImage?: <string>, robots?: <string> }. " +\n'
        '      "Get pageId by calling framer_list_pages first; include only the fields you\'re changing.\\n\\n" +\n'
        '      "  \u2022 framer_publish_page \u2014 { pageId: <string> }. Publish-only path, no field updates. Use after " +\n'
        '      "framer_update_page_draft when the operator approves shipping the draft.\\n\\n" +\n'
        '      "  \u2022 framer_create_draft_page \u2014 { path: <string>, title: <string>, contentBlocks: <array> }. " +\n'
        '      "Use only when proposing a brand-new page (you would normally already have called " +\n'
        '      "framer_create_draft_page directly to get the previewUrl, then propose_action just for the publish step).\\n\\n" +\n'
        '      "If you\'re unsure of the shape, look up the corresponding integration tool\'s input_schema for " +\n'
        '      "guidance \u2014 propose_action\'s toolInput is forwarded verbatim to the executor.",'
    ),
    "new": (
        '"Create a HITL approval request for any action that touches the public site or sends external " +\n'
        '      "messages. DOES NOT execute \u2014 only files the request. " +\n'
        '      "When the action is a Framer blog post you\'ve already drafted via framer_draft_blog_post, the " +\n'
        '      "tool\'s response includes a `next_step` string \u2014 it tells you exactly what toolName and " +\n'
        '      "toolInput to pass here. Copy them verbatim.\\n\\n" +\n'
        '      "REQUIRED toolInput shapes for known toolNames (the executor will reject malformed input):\\n\\n" +\n'
        '      "  \u2022 framer_confirm_publish \u2014 { confirmationHash: <string>, itemId: <string>, slug: <string>, " +\n'
        '      "title: <string> }. Publishes a previewed blog post to production (tarino.au). The " +\n'
        '      "confirmationHash and itemId come from a prior framer_draft_blog_post call. slug and title are " +\n'
        '      "for the approval card display.\\n\\n" +\n'
        '      "  \u2022 framer_rollback_draft \u2014 { itemId: <string>, slug?: <string> }. Removes a draft CMS " +\n'
        '      "item from Framer. Use when a draft will not be published (operator rejected, dupe slug " +\n'
        '      "discovered, etc.).\\n\\n" +\n'
        '      "If you\'re unsure of the shape, look up the corresponding integration tool\'s input_schema for " +\n'
        '      "guidance \u2014 propose_action\'s toolInput is forwarded verbatim to the executor.",'
    ),
})

# --- 2. src/skills/seo/tools.ts: previewUrl description ----------------------

PATCHES.append({
    "file": "src/skills/seo/tools.ts",
    "label": "previewUrl description",
    "old": (
        '"Optional URL the operator can click to preview the change before approving. " +\n'
        '            "For Framer page drafts, pass the previewUrl returned by framer_create_draft_page " +\n'
        '            "or framer_update_page_draft. The Slack approval card renders this as a clickable " +\n'
        '            "\'View preview \u2197\' link.",'
    ),
    "new": (
        '"Optional URL the operator can click to preview the change before approving. " +\n'
        '            "For framer_confirm_publish: there is no staging preview (Framer\'s publish pushes to all " +\n'
        '            "custom hostnames simultaneously), so set this to the production URL the post will appear " +\n'
        '            "at \u2014 https://tarino.au/blog/<slug>. The Slack approval card renders this as a clickable " +\n'
        '            "\'View preview \u2197\' link the operator can use to verify after approval.",'
    ),
})

# --- 3. src/agents/subagent.ts: "New pages" paragraph ------------------------

PATCHES.append({
    "file": "src/agents/subagent.ts",
    "label": "subagent: 'New pages' paragraph",
    "old": (
        '**New pages.** What does ${tenant.clientName} not have a page for, that competitors do? '
        'Use DataForSEO keyword data and competitor sitemaps to find the gap. If you spot a clear '
        'winner, draft the page in Framer (framer_create_draft_page) and surface the preview URL '
        'via propose_action.'
    ),
    "new": (
        '**New blog posts.** What is ${tenant.clientName} not writing about, that competitors are? '
        'Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial '
        'intent. If you spot a clear winner, draft it as a blog post via framer_draft_blog_post '
        '(creates the CMS item AND runs the publish preview in one call). Then file propose_action '
        'using the next_step string the tool returns. NEW LANDING PAGES are NOT yet supported by '
        'the Framer API surface \u2014 if a gap genuinely calls for a new page (not a blog post), log '
        'it as a seo_opportunities entry with the proposed page outline and let the operator '
        'build it in Framer\'s UI.'
    ),
})

# --- 4. src/agents/subagent.ts: "Internal links" paragraph -------------------

PATCHES.append({
    "file": "src/agents/subagent.ts",
    "label": "subagent: 'Internal links' paragraph",
    "old": (
        '**Internal links between existing pages.** Two pages that obviously belong linked but '
        'aren\'t. Push a draft revision of the source page (framer_update_page_draft) and '
        'propose_action with the preview.'
    ),
    "new": (
        '**Internal links between existing pages.** Two pages that obviously belong linked but '
        'aren\'t. The Framer Server API can\'t edit existing page content programmatically today, '
        'so log these as seo_opportunities (log_opportunity) with the specific source page, target '
        'page, and proposed anchor text. The operator implements them in Framer\'s UI directly.'
    ),
})

# --- 5. src/agents/subagent.ts: "Additive copy" paragraph --------------------

PATCHES.append({
    "file": "src/agents/subagent.ts",
    "label": "subagent: 'Additive copy' paragraph",
    "old": (
        '**Additive copy or meta on existing pages.** Strictly additive \u2014 never propose '
        'removing or replacing existing copy. New FAQ section, an additional paragraph that '
        'closes a gap, an expanded meta description. Draft revision + propose_action.'
    ),
    "new": (
        '**Additive copy or meta on existing pages.** Same constraint as internal links: no '
        'programmatic page edits via the current Framer API surface. Log specific proposals to '
        'seo_opportunities (with the exact copy, the placement, and the why) for operator-driven '
        'implementation. New FAQ sections, expanded meta descriptions, additional paragraphs that '
        'close a gap \u2014 all valuable; just not agent-shippable yet.'
    ),
})

# --- 6. src/agents/subagent.ts: "On Framer drafts" section -------------------

PATCHES.append({
    "file": "src/agents/subagent.ts",
    "label": "subagent: 'On Framer drafts' section",
    "old": (
        '## On Framer drafts\n'
        '\n'
        'If framer_create_draft_page returns a previewUrl that looks like a regular live URL '
        '(no staging prefix), the workspace plan doesn\'t support native drafts and the page '
        'was created as live-but-noindex\'d. That still works \u2014 the operator clicks through, '
        'sees the rendered page, Google won\'t index it, and approval removes the noindex. '
        'Mention "preview" in the proposedAction either way; the operator doesn\'t need to '
        'know which mode.'
    ),
    "new": (
        '## On Framer blog posts\n'
        '\n'
        'To propose a new blog post:\n'
        '\n'
        '1. Call framer_get_changed_paths first. If it shows any pending changes in the '
        'workspace, STOP \u2014 surface the situation to the operator rather than proceeding. '
        'Publishing would bundle those changes with your post.\n'
        '2. Call framer_list_blog_items to confirm your proposed slug is unique and to study '
        'the existing post style and topic mix.\n'
        '3. Call framer_draft_blog_post with { slug, title, content }. Content is HTML in '
        'Framer\'s formattedText format (<p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.). '
        'The tool creates the CMS item AND runs the publish preview in one shot.\n'
        '4. The response includes a `next_step` string \u2014 it tells you exactly what to put in '
        'propose_action. Copy the toolName and toolInput verbatim.\n'
        '5. On approval, the post goes live at https://tarino.au/blog/<slug>. On rejection '
        '(or if the operator never decides), the draft sits as an unpublished CMS item in '
        'Framer. framer_rollback_draft can clean it up later if needed.\n'
        '\n'
        'NOT supported by the current Framer API surface: editing existing pages, changing '
        'SEO meta on pages, creating new landing pages. For those, log a seo_opportunities '
        'entry with the specific proposal and let the operator implement in Framer\'s UI.'
    ),
})

# --- 7. src/core/slack/render.ts: inferActionKind Framer block ---------------

PATCHES.append({
    "file": "src/core/slack/render.ts",
    "label": "render.ts: Framer tool-name mappings",
    "old": (
        "  // Framer page operations + GSC submission = publishing content\n"
        "  if (n.startsWith('framer_create_draft_page')) return 'publish_content'\n"
        "  if (n.startsWith('framer_update_page_draft')) return 'publish_content'\n"
        "  if (n.startsWith('framer_publish'))            return 'publish_content'\n"
        "  if (n.startsWith('framer_deploy'))             return 'publish_content'\n"
        "  if (n.startsWith('framer_update_page_seo'))    return 'modify_live_page'\n"
        "  if (n.startsWith('framer_update_cms'))         return 'modify_live_page'\n"
        "  if (n.startsWith('framer_'))                   return 'modify_live_page'\n"
    ),
    "new": (
        "  // Framer (two-phase blog publish via framer_draft_blog_post + framer_confirm_publish)\n"
        "  if (n.startsWith('framer_confirm_publish')) return 'publish_content'\n"
        "  if (n.startsWith('framer_rollback_draft'))  return 'commit_data_change'\n"
        "  if (n.startsWith('framer_'))                return 'modify_live_page'\n"
    ),
})

# -----------------------------------------------------------------------------
# Apply
# -----------------------------------------------------------------------------

def apply_patches():
    # Group patches by file so we read/write each file once
    by_file = {}
    for p in PATCHES:
        by_file.setdefault(p["file"], []).append(p)

    errors = []
    for filepath, patches in by_file.items():
        if not os.path.isfile(filepath):
            errors.append(f"  MISSING FILE: {filepath}")
            continue

        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()

        # Snapshot for the backup
        original = content

        applied_labels = []
        for patch in patches:
            if patch["old"] in content:
                content = content.replace(patch["old"], patch["new"], 1)
                applied_labels.append(patch["label"])
            else:
                errors.append(
                    f"  NO MATCH in {filepath}: '{patch['label']}' \u2014 "
                    f"anchor text not found. File may have drifted from expected version."
                )

        if applied_labels and content != original:
            backup = filepath + ".phase5.bak"
            shutil.copy(filepath, backup)
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            print(f"\u2713 {filepath}")
            for label in applied_labels:
                print(f"    - {label}")
            print(f"    (original backed up at {backup})")

    print()
    if errors:
        print("Errors:")
        for e in errors:
            print(e)
        print()
        print(
            "If a NO MATCH happened, the file in your tree differs from the version I "
            "analyzed. Open the file at the relevant line range, locate the closest "
            "matching text, and apply the change by hand. The replacements are listed "
            "in this script's PATCHES array."
        )
        sys.exit(1)
    else:
        print("\u2713 All patches applied cleanly.")
        print()
        print("Next steps:")
        print("  1. git diff src/skills/seo/tools.ts src/agents/subagent.ts src/core/slack/render.ts")
        print("  2. npx tsc --noEmit  (sanity check)")
        print("  3. Remove .phase5.bak files once happy")

if __name__ == "__main__":
    apply_patches()
