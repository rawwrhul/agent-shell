import { openFramerSession } from '../src/integrations/framer/client'
import { getTenant } from '../src/tenants/registry'
import { findBlogCollection } from '../src/integrations/framer/cms-write'

;(async () => {
  const tenant = await getTenant('tarino')
  if (!tenant) { console.error('no tenant'); process.exit(1) }

  const session = await openFramerSession(tenant)
  try {
    const blog = await findBlogCollection(session.client)

    const fields = await blog.getFields()
    console.log('\n=== Blog collection fields ===')
    for (const f of fields) {
      console.log(`  id=${f.id}  name=${f.name}  type=${f.type}`)
    }

    const items = await blog.getItems()
    if (items.length === 0) { console.log('\nno items'); process.exit(0) }

    const sample = items[0]
    console.log(`\n=== Sample item: ${sample.slug} ===`)
    for (const [fid, field] of Object.entries(sample.fieldData ?? {})) {
      const f: any = field
      const vDesc = f?.value === null ? 'null'
                  : f?.value === undefined ? 'undefined'
                  : `${typeof f.value}: ${JSON.stringify(f.value).slice(0, 120)}`
      console.log(`  ${fid}  type=${f?.type}  value=${vDesc}`)
    }

    console.log(`\nTotal items: ${items.length}`)
    process.exit(0)
  } catch (err) {
    console.error('error:', err)
    process.exit(1)
  } finally {
    try { await session.disconnect() } catch {}
  }
})()
