const fs = require('fs')
const path = 'src/integrations/framer/cms-write.ts'
const src = fs.readFileSync(path, 'utf-8')

// Replace the previous sanitize-only block with one that handles BOTH
// image objects (must become ID strings) and undefined (must become null).
const oldMain = `    const mergedFieldData: Record<string, any> = { ...item.fieldData, ...fieldUpdates }
    for (const fid in mergedFieldData) {
      const f = mergedFieldData[fid]
      if (f && f.value === undefined) {
        mergedFieldData[fid] = { ...f, value: null }
      }
    }
    await item.setAttributes({
      fieldData: mergedFieldData,
    })`
const newMain = `    const mergedFieldData: Record<string, any> = sanitizeFieldDataForWrite({ ...item.fieldData, ...fieldUpdates })
    await item.setAttributes({
      fieldData: mergedFieldData,
    })`

// Same fix on the restore path.
const oldRestore = `        const restoreFieldData = { ...item.fieldData }
        for (const snap of before) {
          if (snap.value !== undefined) {
            restoreFieldData[snap.fieldId] = { type: snap.type, value: snap.value }
          }
        }
        await item.setAttributes({
          fieldData: restoreFieldData,
        })`
const newRestore = `        const restoreFieldData: Record<string, any> = { ...item.fieldData }
        for (const snap of before) {
          if (snap.value !== undefined) {
            restoreFieldData[snap.fieldId] = { type: snap.type, value: snap.value }
          }
        }
        await item.setAttributes({
          fieldData: sanitizeFieldDataForWrite(restoreFieldData),
        })`

// Insert the helper function before applyBlogItemEdit.
const helper = `// Framer reads image fields as { id, url, thumbnails, ... } objects but its
// setAttributes API rejects those with a typia validation error expecting null|string.
// It expects just the asset id string. Same goes for undefined values on
// newly-added schema fields that haven't been populated on existing items.
function sanitizeFieldDataForWrite(data: Record<string, any>): Record<string, any> {
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
}

export async function applyBlogItemEdit(`

if (!src.includes(oldMain))    { console.error('main block pattern not found');    process.exit(1) }
if (!src.includes(oldRestore)) { console.error('restore block pattern not found'); process.exit(1) }
if (!src.includes('export async function applyBlogItemEdit(')) { console.error('applyBlogItemEdit signature not found'); process.exit(1) }

let out = src
  .replace(oldMain, newMain)
  .replace(oldRestore, newRestore)
  .replace('export async function applyBlogItemEdit(', helper)

fs.writeFileSync(path, out)
console.log('Patched cms-write.ts')
