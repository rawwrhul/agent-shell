const fs = require('fs')
const path = require('path')

const patches = [
  {
    file: 'src/core/slack/blocks/shared.ts',
    label: 'shared.ts: defensive Date | string in formatTime/formatDate/formatRelative',
    sentinel: 'toDate(d: Date | string)',
    edits: [
      {
        old: `export function formatTime(d: Date, tz = 'Australia/Sydney'): string {`,
        new: `// Defensive coercion: the LLM returns dates as JSON strings, not Date
// objects. TypeScript can't catch this at compile time because the
// types claim Date — so we coerce at the call site.
function toDate(d: Date | string): Date {
  return d instanceof Date ? d : new Date(d)
}

export function formatTime(d: Date | string, tz = 'Australia/Sydney'): string {
  d = toDate(d)`,
      },
      {
        old: `export function formatDate(d: Date, tz = 'Australia/Sydney'): string {`,
        new: `export function formatDate(d: Date | string, tz = 'Australia/Sydney'): string {
  d = toDate(d)`,
      },
      {
        old: `export function formatRelative(d: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - d.getTime();`,
        new: `export function formatRelative(d: Date | string, now: Date = new Date()): string {
  d = toDate(d)
  const diffMs = now.getTime() - d.getTime();`,
      },
    ],
  },

  {
    file: 'src/core/slack/blocks/daily-run.ts',
    label: 'daily-run.ts: defensive Date | string in formatNextRunLabel',
    sentinel: 'd instanceof Date ? d : new Date(d)',
    edits: [
      {
        old: `function formatNextRunLabel(d: Date): string {
  const now = new Date();
  const diffHr = (d.getTime() - now.getTime()) / 3_600_000;`,
        new: `function formatNextRunLabel(d: Date | string): string {
  d = d instanceof Date ? d : new Date(d)
  const now = new Date();
  const diffHr = (d.getTime() - now.getTime()) / 3_600_000;`,
      },
    ],
  },
]

let allDone = true
for (const p of patches) {
  const abs = path.resolve(process.cwd(), p.file)
  if (!fs.existsSync(abs)) { console.error('NOT FOUND:', p.file); process.exit(1) }
  const src = fs.readFileSync(abs, 'utf8')
  if (src.includes(p.sentinel)) {
    console.log('• ' + p.label + ': already patched')
    continue
  }
  allDone = false
  let next = src
  for (const e of p.edits) {
    if (!next.includes(e.old)) {
      console.error('ANCHOR NOT FOUND in ' + p.file)
      console.error('  Expected (first 200 chars):')
      console.error('  ' + e.old.slice(0, 200).replace(/\n/g, '\n  '))
      process.exit(1)
    }
    next = next.replace(e.old, e.new)
  }
  fs.writeFileSync(abs, next)
  console.log('✓ Patched ' + p.file)
}

if (allDone) console.log('patches already applied')
else console.log('done')
