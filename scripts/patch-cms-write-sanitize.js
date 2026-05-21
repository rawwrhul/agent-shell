const fs = require('fs')
const path = 'src/integrations/framer/cms-write.ts'
const src = fs.readFileSync(path, 'utf-8')
const oldBlock = `    const mergedFieldData = { ...item.fieldData, ...fieldUpdates }
    await item.setAttributes({
      fieldData: mergedFieldData,
    })`
const newBlock = `    const mergedFieldData: Record<string, any> = { ...item.fieldData, ...fieldUpdates }
    for (const fid in mergedFieldData) {
      const f = mergedFieldData[fid]
      if (f && f.value === undefined) {
        mergedFieldData[fid] = { ...f, value: null }
      }
    }
    await item.setAttributes({
      fieldData: mergedFieldData,
    })`
if (!src.includes(oldBlock)) {
  console.error('Pattern not found. Aborting.')
  process.exit(1)
}
fs.writeFileSync(path, src.replace(oldBlock, newBlock))
console.log('Patched cms-write.ts')
