const fs = require('fs')
const path = 'src/integrations/framer/cms-write.ts'
const src = fs.readFileSync(path, 'utf-8')

const oldHelper = `function sanitizeFieldDataForWrite(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [fid, field] of Object.entries(data)) {
    const f: any = field
    if (!f) { out[fid] = f; continue }
    if (f.type === 'image' && f.value && typeof f.value === 'object' && 'id' in f.value) {
      out[fid] = { ...f, value: f.value.id }
    } else if (f.value === undefined) {
      out[fid] = { ...f, value: null }
    } else {
      out[fid] = f
    }
  }
  return out
}`

const newHelper = `function sanitizeFieldDataForWrite(data: Record<string, any>): Record<string, any> {
  // setAttributes is a partial update — only include text-type fields.
  // Image / date / file etc. have read/write asymmetry that breaks Framer's
  // validation; sending them back unchanged trips typia and URL constructors.
  // Omitting them preserves their existing values (setAttributes only touches
  // what's in the payload).
  const out: Record<string, any> = {}
  for (const [fid, field] of Object.entries(data)) {
    const f: any = field
    if (!f) continue
    if (f.type === 'string' || f.type === 'formattedText') {
      out[fid] = f.value === undefined ? { ...f, value: null } : f
    }
  }
  return out
}`

if (!src.includes(oldHelper)) {
  console.error('helper pattern not found — file may have already been patched differently')
  process.exit(1)
}
fs.writeFileSync(path, src.replace(oldHelper, newHelper))
console.log('Patched sanitizeFieldDataForWrite')
