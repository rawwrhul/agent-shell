// wire-tighten-article-priority.js
//
// Tightens the article-priority prompt to cap blog post creation at
// ONE per run, preventing the token-budget overrun that produced the
// hung Sunday 9am run (118K/100K tokens used, aggregator hung on
// "synthesising final report").
//
// One-line patch in src/agents/subagent.ts.

const fs = require('fs')
const path = require('path')

const file = path.resolve(process.cwd(), 'src/agents/subagent.ts')
const src = fs.readFileSync(file, 'utf8')

const SENTINEL = 'Draft EXACTLY ONE blog post per run'
if (src.includes(SENTINEL)) {
  console.log('✓ already patched')
  process.exit(0)
}

const oldText = `Article creation is the **primary growth lever** for this tenant. Default to drafting at least one new blog post per daily run unless you genuinely cannot find a defensible topic gap. The other categories below are real work, but they are secondary — they harden what already exists. New articles are how we expand surface area and rankings into clusters we don't currently own.`

const newText = `Article creation is the **primary growth lever** for this tenant. Draft EXACTLY ONE blog post per run — pick the strongest topic gap and execute it well. Do NOT attempt 2 or more blog posts in a single run; the token budget will not support it and the run will hang at synthesis. The other categories below are real work, but they are secondary — they harden what already exists. New articles are how we expand surface area and rankings into clusters we don't currently own.`

if (!src.includes(oldText)) {
  console.error('anchor not found — subagent.ts has drifted')
  process.exit(1)
}

fs.writeFileSync(file, src.replace(oldText, newText))
console.log('✓ Patched src/agents/subagent.ts — capped at one blog post per run')
console.log('')
console.log('Next: tsc, commit, push, merge to main.')
