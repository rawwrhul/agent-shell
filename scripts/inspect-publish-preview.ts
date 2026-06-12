import { openFramerSession } from '../src/integrations/framer/client'
import { getTenant } from '../src/tenants/registry'

;(async () => {
  const tenant = await getTenant('tarino')
  if (!tenant) process.exit(1)
  const session = await openFramerSession(tenant)
  try {
    const framer: any = session.client
    console.log('Calling publishForAgent({ action: "preview" })...')
    const preview = await framer.publishForAgent({ action: 'preview' })
    console.log('\n=== Full preview response ===')
    console.log(JSON.stringify(preview, null, 2))
    process.exit(0)
  } catch (err) {
    console.error('preview call failed:', err)
    process.exit(1)
  } finally {
    try { await session.disconnect() } catch {}
  }
})()
