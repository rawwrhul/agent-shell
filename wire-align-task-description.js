const fs = require('fs')
const path = require('path')

const file = path.resolve(process.cwd(), 'src/scheduler/worker.ts')
const src = fs.readFileSync(file, 'utf8')

const SENTINEL = 'Your job today is DRAFTING'
if (src.includes(SENTINEL)) {
  console.log('already patched')
  process.exit(0)
}

const oldStart = `return \`Morning generation run for \${clientName}`
const oldEnd = `Snapshot today's baseline metrics at some point so we have continuity for tomorrow.\`;`

const startIdx = src.indexOf(oldStart)
const endIdx = src.indexOf(oldEnd)
if (startIdx === -1 || endIdx === -1) {
  console.error('anchor not found in worker.ts — file has drifted')
  process.exit(1)
}

const oldText = src.slice(startIdx, endIdx + oldEnd.length)

const newText = `return \`Morning generation run for \${clientName}.

Your job today is DRAFTING, not DISCOVERY. Background runs already populated the opportunity bank with audit findings, backlink prospects, and unlinked brand mentions — the aggregator will surface those automatically from seo_opportunities into this run's Slack post. Do not re-run audits, do not re-fetch competitor backlinks, do not re-scan for brand mentions. Those are already done and waiting in the table.

What to draft inline this run (in priority order):

1. ONE new blog post on a topic gap. Find a keyword cluster competitors rank for that \${clientName} doesn't have a page for, draft the full post, file via propose_action with toolName='framer_create_and_publish_blog_post'. This is the primary deliverable.

2. 2-3 quick on-page improvements for existing pages. Concrete copy tweaks, meta-description rewrites, schema additions, or internal-link insertions you spot while reviewing the site. File each via propose_action with toolName='manual_operator_task' and a clear instruction including the target page + the exact change.

3. Refine bank outreach drafts if you spot one that needs work. The backlink_prospector skill drafts a generic pitch for each prospect; if you can write a stronger version for a specific high-value target, do so and file via propose_action with toolName='manual_operator_task' explaining the upgrade.

Keep the run bounded: one blog post + 2-3 quick fixes + maybe one outreach refinement. Do NOT attempt multiple blog posts in a single run; the token budget will not support it. Lean on the bank for everything that's already been discovered.

Snapshot today's baseline metrics at some point so we have continuity for tomorrow.\`;`

fs.writeFileSync(file, src.replace(oldText, newText))
console.log('Patched src/scheduler/worker.ts — daily task is now drafting-focused, bank handles discovery')
