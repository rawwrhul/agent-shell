import { openFramerSession } from '../src/integrations/framer/client'
import { getTenant } from '../src/tenants/registry'
import { findBlogCollection, findBlogItemBySlug } from '../src/integrations/framer/cms-write'

;(async () => {
  const tenant = await getTenant('tarino')
  if (!tenant) process.exit(1)
  const session = await openFramerSession(tenant)
  try {
    const blog = await findBlogCollection(session.client)
    const item = await findBlogItemBySlug(blog, 'offshore-hiring-mistakes-australia')
    const contentField = Object.values(item.fieldData ?? {}).find((f: any) => f?.type === 'formattedText') as any
    const html: string = contentField?.value ?? ''

    const urls = [...html.matchAll(/href=["']([^"']*)["']/gi)].map(m => m[1])
    console.log(`\nFound ${urls.length} href values in body:\n`)
    for (const u of urls) {
      let valid = false
      try { new URL(u); valid = true } catch {}
      console.log(`  [${valid ? 'OK' : '!!'}] ${u}`)
    }
    process.exit(0)
  } finally {
    try { await session.disconnect() } catch {}
  }
})()
