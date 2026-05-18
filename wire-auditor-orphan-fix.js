// wire-auditor-orphan-fix.js
//
// Bundle 1 of the next merge: synthesis prompt orphan→add_to_sitemap mislabel fix.
//
// Adds a TYPE MAPPING RULES section to the synthesis prompt so the LLM never
// picks 'add_to_sitemap' as the opportunity type for orphan_page findings.
// (Tarino's last audit produced one such mislabeled opportunity.)
//
// Idempotent: re-running after success exits 0 without changing anything.
//
// Usage (from repo root):
//   node wire-auditor-orphan-fix.js
//
// After running:
//   npx tsc --noEmit           # must pass clean
//   npm run audit tarino       # optional — confirms LLM obeys new rule

const fs = require('fs')
const path = require('path')

const target = path.resolve(
  process.cwd(),
  'src/skills/seo-technical-auditor/synthesis.ts',
)

if (!fs.existsSync(target)) {
  console.error('ERROR: target file not found at', target)
  console.error('Run this script from the repo root (the directory with package.json).')
  process.exit(1)
}

let src = fs.readFileSync(target, 'utf8')

// Anchor: the end of GROUPING RULES + the blank line + start of NARRATIVE RULES.
// This block is unique in synthesis.ts.
const anchor = `- findingIds MUST be picked from the [id:...] prefix on the findings listed above. Never invent IDs or leave the array empty.

NARRATIVE RULES:`

const replacement = `- findingIds MUST be picked from the [id:...] prefix on the findings listed above. Never invent IDs or leave the array empty.

TYPE MAPPING RULES (strict):
- orphan_page finding → 'add_internal_link_to_orphan'. NEVER 'add_to_sitemap'. Orphans are pages that exist and are reachable but have no internal links pointing to them; the fix is to link to them from an existing page.
- 'add_to_sitemap' is reserved for indexable pages missing from sitemap.xml. If no finding identifies such a page, do not use this type.

NARRATIVE RULES:`

if (src.includes('TYPE MAPPING RULES (strict):')) {
  console.log('✓ Already patched — TYPE MAPPING RULES section is present. No changes made.')
  process.exit(0)
}

if (!src.includes(anchor)) {
  console.error('ERROR: anchor text not found in synthesis.ts.')
  console.error('The file may have changed since this patch was authored.')
  console.error('')
  console.error('Expected anchor:')
  console.error(anchor)
  process.exit(1)
}

src = src.replace(anchor, replacement)
fs.writeFileSync(target, src)

console.log('✓ Patched', target)
console.log('  Added TYPE MAPPING RULES section to the synthesis prompt.')
console.log('')
console.log('Next steps:')
console.log('  1. npx tsc --noEmit            # verify type-check passes')
console.log('  2. npm run audit tarino        # optional — verify LLM obeys rule')
console.log('  3. git diff src/skills/seo-technical-auditor/synthesis.ts   # eyeball the change')
