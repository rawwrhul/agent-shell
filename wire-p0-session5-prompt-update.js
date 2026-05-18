#!/usr/bin/env node
// wire-p0-session5-prompt-update.js
//
// P0 Session 5: prompt update.
//
// Without this, the agent keeps defaulting to manual_operator_task for
// everything because the existing prompts explicitly say "Framer Server API
// can't edit existing page content programmatically today" — which was true
// before today, false now.
//
// Files patched:
//   - src/agents/subagent.ts       (main agent prompt — what to file when)
//   - src/scheduler/worker.ts      (daily run task brief)
//   - src/skills/seo/tools.ts      (propose_action tool description)
//
// Idempotent. Safe to re-run.
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const FILES = {
  subagent:   path.join(ROOT, 'src/agents/subagent.ts'),
  worker:     path.join(ROOT, 'src/scheduler/worker.ts'),
  seoTools:   path.join(ROOT, 'src/skills/seo/tools.ts'),
}

function assertExists(p) {
  if (!fs.existsSync(p)) {
    console.error(`✗  missing: ${p}`)
    process.exit(1)
  }
}
Object.values(FILES).forEach(assertExists)

let totalReplacements = 0

function replaceOnce(filepath, oldStr, newStr, label) {
  const content = fs.readFileSync(filepath, 'utf8')
  if (content.includes(newStr.slice(0, 100))) {
    console.log(`⚠  ${label}: already patched — skipping`)
    return false
  }
  if (!content.includes(oldStr)) {
    console.error(`✗  ${label}: OLD pattern not found in ${path.relative(ROOT, filepath)}`)
    console.error(`   Expected to find (first 200 chars):`)
    console.error(`   ${oldStr.slice(0, 200)}…`)
    process.exit(1)
  }
  const occurrences = content.split(oldStr).length - 1
  if (occurrences > 1) {
    console.error(`✗  ${label}: OLD pattern matches ${occurrences} times — ambiguous`)
    process.exit(1)
  }
  fs.writeFileSync(filepath, content.replace(oldStr, newStr), 'utf8')
  console.log(`✅ ${label}`)
  totalReplacements++
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. src/agents/subagent.ts — Replace lines 695-699 (the "What to file" section)
// ─────────────────────────────────────────────────────────────────────────────

const SUBAGENT_OLD_1 = `**New blog posts — primary focus.** What is \${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. If you spot a clear winner, write the post and file it directly via propose_action with toolName='framer_create_and_publish_blog_post' — toolInput holds the full content inline ({ slug, title, content, imageUrl? }). The executor creates the CMS item AND publishes on operator approval, in one atomic step. Nothing is created in Framer until approval — clean reject = no cleanup needed. For NEW LANDING PAGES (not blog posts), the Framer Server API can't create them programmatically — propose_action with toolName='manual_operator_task' instead, giving the operator the page outline + a list of pages to add to nav etc.

**Internal links between existing pages.** Two pages that obviously belong linked but aren't. The Framer Server API can't edit existing page content programmatically today, so file these via propose_action with toolName='manual_operator_task' and toolInput={ instruction: <source page + target page + exact anchor text + where to place the link>, category: 'linking' }. The operator does the actual edit in Framer's UI.

**Additive copy or meta on existing pages.** Same constraint as internal links: no programmatic page edits. File these via propose_action with toolName='manual_operator_task' and toolInput={ instruction: <the exact copy + the page + where on the page>, category: 'copy' or 'meta' }. New FAQ sections, expanded meta descriptions, additional paragraphs — all valuable and now ship through the same approval workflow as blog posts, just acknowledged-on-approve rather than auto-published.`

const SUBAGENT_NEW_1 = `**New blog posts — primary focus.** What is \${tenant.clientName} not writing about, that competitors are? Use DataForSEO keyword data and competitor sitemaps to find topic gaps with commercial intent. If you spot a clear winner, write the post and file it via propose_action with toolName='approve_blog_pitch' — toolInput holds the full content inline ({ slug, title, content, imageUrl?, whyThisTopic? }). Two-stage flow: Stage 1 approve creates the Framer draft so the operator can review the rendered post in Framer's editor; Stage 2 approve publishes to the live site. Clean reject at either stage = nothing on the live site.

For NEW MARKETING/LANDING PAGES (not blog posts), page creation is currently scoped OUT of automation — agent has no design API to produce production-quality layouts. File with toolName='manual_operator_task' giving the operator a complete design brief: target keyword, search intent, page structure (hero/sections/CTAs), internal link plan, and navigation placement.

**Edits to existing BLOG POSTS (CMS-driven, /resources/<slug>):**
  - Meta title or description → propose_action with toolName='framer_update_blog_meta', toolInput={ slug, newTitle?, newDescription? }, riskLevel='medium'. Description updates require Tarino's Blog schema to have a Description field (one-time UI setup); executor returns clear setup error if missing.
  - Body content refresh, new section, content rewrite → propose_action with toolName='framer_update_blog_body', toolInput={ slug, newContent }, riskLevel='high'. newContent is the FULL new HTML in Framer formattedText (<p dir="auto">, <h2>, <strong>, <ul>, <li>, <a href>). Operator reviews full HTML in the approval card.
  - Image alt text → propose_action with toolName='framer_add_blog_alt_text', toolInput={ slug, newAltText }, riskLevel='low'.
  - Add ONE internal link to another resource → propose_action with toolName='framer_add_internal_link', toolInput={ slug, sourceText, targetUrl }, riskLevel='medium'. Wraps first matching sourceText in an <a> tag. For BULK link changes or body rewrites, use framer_update_blog_body instead.

**Edits to MARKETING PAGES (non-CMS: About, Contact, Resources index, homepage, etc.):**
  - Body text changes (headlines, paragraphs, CTAs) → propose_action with toolName='framer_update_marketing_page_text', toolInput={ pagePath, oldText, newText }, riskLevel='high'. oldText must EXACTLY match the current text in Framer's data model. Use web_fetch on the live page first to identify the exact target string. On mismatch, the executor returns sample texts from the page so you can retry with the corrected oldText.
  - Internal links between marketing pages → no targeted tool yet — file as toolName='manual_operator_task' with toolInput={ instruction: <source page + target page + exact anchor text + where on the page>, category: 'linking' }.
  - Meta title or meta description → toolName='manual_operator_task'. Marketing-page Page Settings are NOT exposed via the Framer API. The instruction must be precise: "Open Framer → /<page> → Page Settings → set Title to '<exact new title>' and Description to '<exact new description>' → Publish".

**Site-wide JSON-LD schema / structured data:**
  - Organization, WebSite, LocalBusiness, etc. → propose_action with toolName='framer_add_site_schema', toolInput={ schemaId, jsonLd }, riskLevel='high'. schemaId is a stable identifier ('organization', 'website', etc.) — re-runs with the same schemaId UPDATE rather than duplicate. jsonLd is a JSON string with @context and @type.
  - Per-page schema (e.g. Article on a specific blog post): not directly supported via setCustomCode; use manual_operator_task for now.

**Genuine API limits — these CORRECTLY use manual_operator_task:**
  - Marketing page meta title/description (Page Settings is UI-only)
  - robots.txt edits (Framer auto-generates; Well-Known Files upload is UI-only on Pro+)
  - sitemap.xml direct edits (auto-generated; only indirect control via per-page "Show in search engines" toggle)
  - Per-page canonical override (Enterprise UI only)
  - Per-page noindex toggle (Page Settings UI only)
  - New marketing landing pages (design brief — see above)
  - Internal links on marketing pages (no targeted tool yet)

For these, the instruction field in toolInput must be precise enough that the operator completes the task in Framer's UI without further input. Include: exact target page + section, exact strings to paste verbatim, location on the page, and rationale.`

replaceOnce(FILES.subagent, SUBAGENT_OLD_1, SUBAGENT_NEW_1, 'subagent.ts: tool taxonomy section')

// ─────────────────────────────────────────────────────────────────────────────
// 2. src/agents/subagent.ts — Replace line 812 area
// ─────────────────────────────────────────────────────────────────────────────

const SUBAGENT_OLD_2 = `For non-blog work — schema markup, internal linking inside EXISTING posts, copy edits on live pages, meta tag updates, new landing pages — use propose_action with toolName="manual_operator_task". The instruction field should be detailed enough that the operator can do the work in Framer's editor without further input from you.`

const SUBAGENT_NEW_2 = `For non-blog work, pick the right tool from the taxonomy above. Quick reference: marketing page body text → framer_update_marketing_page_text; blog meta → framer_update_blog_meta; blog body → framer_update_blog_body; blog alt text → framer_add_blog_alt_text; blog internal links → framer_add_internal_link; site-wide JSON-LD schema → framer_add_site_schema. ONLY use manual_operator_task when no API tool above applies: marketing-page meta titles/descriptions, robots.txt edits, sitemap.xml direct edits, per-page canonicals or noindex toggles, new marketing pages (design brief), or internal links on marketing pages. When you DO use manual_operator_task, the instruction field must be precise enough that the operator can complete the task in Framer's editor without further input from you.`

replaceOnce(FILES.subagent, SUBAGENT_OLD_2, SUBAGENT_NEW_2, 'subagent.ts: non-blog work section')

// ─────────────────────────────────────────────────────────────────────────────
// 3. src/scheduler/worker.ts — Replace daily-run task brief item 2
// ─────────────────────────────────────────────────────────────────────────────

const WORKER_OLD = `2. 2-3 quick on-page improvements for existing pages. Concrete copy tweaks, meta-description rewrites, schema additions, or internal-link insertions you spot while reviewing the site. File each via propose_action with toolName='manual_operator_task' and a clear instruction including the target page + the exact change.`

const WORKER_NEW = `2. 2-3 quick on-page improvements for existing pages. Pick the right tool based on what you're changing:
   - Blog meta (title/description) → framer_update_blog_meta, toolInput={ slug, newTitle?, newDescription? }
   - Blog body refresh or content additions → framer_update_blog_body, toolInput={ slug, newContent }
   - Blog image alt text → framer_add_blog_alt_text, toolInput={ slug, newAltText }
   - Internal link inside a blog post body → framer_add_internal_link, toolInput={ slug, sourceText, targetUrl }
   - Marketing page body text (About/Contact/etc) → framer_update_marketing_page_text, toolInput={ pagePath, oldText, newText }
   - Site-wide JSON-LD schema → framer_add_site_schema, toolInput={ schemaId, jsonLd }
   - Marketing page meta / robots.txt / sitemap / canonicals / per-page noindex → manual_operator_task with precise Framer-UI instructions (these are genuine API limits, not gaps).`

replaceOnce(FILES.worker, WORKER_OLD, WORKER_NEW, 'worker.ts: daily-run task brief')

// ─────────────────────────────────────────────────────────────────────────────
// 4. src/skills/seo/tools.ts — Replace tool description (around line 169)
// ─────────────────────────────────────────────────────────────────────────────

const SEOTOOLS_OLD = `      "  • manual_operator_task — for changes Framer's Server API can't do programmatically. " +
      "Use this for schema markup pastes, internal linking edits, copy changes on existing pages, page-level SEO meta edits, new landing pages. " +
      "toolInput = { instruction: <full step-by-step instructions including any JSON-LD / HTML / anchor-text strings the operator needs to paste, verbatim>, category?: <'schema' | 'linking' | 'copy' | 'meta' | 'new-page'> }. " +
      "On approve: executor records acknowledgement. The actual change happens by the operator's hand in Framer's editor.\\n\\n" +`

const SEOTOOLS_NEW = `      "  • framer_update_blog_meta — update Title and/or Description CMS fields on an EXISTING blog post. " +
      "toolInput = { slug, newTitle?, newDescription? }. At least one of newTitle/newDescription required. " +
      "On approve: executor updates the CMS field(s), publishes, deploys to production. Title-only works on Tarino's current schema; description requires one-time UI setup. riskLevel='medium'.\\n\\n" +
      "  • framer_update_blog_body — replace the Content field (HTML formattedText) on an existing blog post. " +
      "toolInput = { slug, newContent }. newContent is the FULL new HTML body. " +
      "Use this for content refreshes, new sections, embedding internal links via <a href> in the HTML. " +
      "Refuses to clobber if newContent is <50 chars. riskLevel='high'.\\n\\n" +
      "  • framer_add_blog_alt_text — add/update alt text on the Image field of an existing blog post. " +
      "toolInput = { slug, newAltText }. riskLevel='low'.\\n\\n" +
      "  • framer_add_internal_link — wrap the first matching sourceText in an existing blog body with an <a href> pointing to targetUrl. " +
      "toolInput = { slug, sourceText, targetUrl }. Refuses if a link to targetUrl already exists in the post. " +
      "For bulk link changes or body rewrites, use framer_update_blog_body instead. riskLevel='medium'.\\n\\n" +
      "  • framer_add_site_schema — inject a site-wide JSON-LD schema block via setCustomCode at headEnd. " +
      "toolInput = { schemaId, jsonLd }. schemaId is a STABLE identifier ('organization', 'website') so re-runs UPDATE rather than duplicate. jsonLd is a JSON string with @context and @type. riskLevel='high'.\\n\\n" +
      "  • framer_update_marketing_page_text — surgical text update on a non-CMS marketing page (About/Contact/Resources/homepage). " +
      "toolInput = { pagePath: <e.g. '/about'>, oldText: <EXACT current text>, newText: <replacement> }. " +
      "On match failure, executor returns sample texts from the page so you can retry. " +
      "Use web_fetch first to read the live page and identify the exact target string. riskLevel='high'.\\n\\n" +
      "  • manual_operator_task — ONLY for changes the Framer API genuinely can't do: " +
      "marketing-page meta titles/descriptions, robots.txt, sitemap.xml, per-page canonicals/noindex toggles, new marketing landing pages, internal links on marketing pages. " +
      "toolInput = { instruction: <precise step-by-step the operator follows in Framer's UI, including exact strings to paste verbatim>, category?: <'schema' | 'linking' | 'copy' | 'meta' | 'new-page' | 'robots-txt' | 'sitemap' | 'canonical' | 'noindex'> }. " +
      "On approve: executor records acknowledgement; operator does the work in Framer.\\n\\n" +`

replaceOnce(FILES.seoTools, SEOTOOLS_OLD, SEOTOOLS_NEW, 'seo/tools.ts: tool descriptions')

console.log('')
console.log('═══════════════════════════════════════════════════════════════════')
console.log(`Session 5 wire-up complete: ${totalReplacements} prompt sections updated`)
console.log('═══════════════════════════════════════════════════════════════════')
console.log('')
console.log('1. Verify TypeScript:  npx tsc --noEmit')
console.log('')
console.log('2. Deploy:')
console.log('   git add -A && git commit -m "prompt: teach agent the new tool taxonomy (P0 session 5)"')
console.log('   git push origin main')
console.log('')
console.log('3. Once deployed, trigger an on-demand run and watch for:')
console.log('   - Agent files propose_action with new tool names')
console.log('     (framer_update_blog_meta, framer_update_blog_body, etc.)')
console.log('   - Approval cards show specific changes, not generic acknowledgments')
console.log('   - Approve one card → verify the change ships to tarino.au')
console.log('')
console.log('4. If the agent still defaults to manual_operator_task for everything,')
console.log('   check the daily-run task in worker.ts is being picked up (the prompts')
console.log('   stack: subagent.ts system prompt + worker.ts task brief).')
