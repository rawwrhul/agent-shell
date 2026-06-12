import { openFramerSession } from '../src/integrations/framer/client'
import { getTenant } from '../src/tenants/registry'

;(async () => {
  const tenantId = 'tarino'
  console.log(`Testing Framer connection for ${tenantId}...`)
  const t0 = Date.now()
  const tenant = await getTenant(tenantId)
  if (!tenant) { console.error('tenant not found'); process.exit(1) }
  console.log('projectUrl:', tenant.framer_project_url)
  try {
    const session = await openFramerSession(tenant)
    const elapsed = Date.now() - t0
    console.log(`Connected in ${elapsed}ms`)
    await session.disconnect()
    console.log('Disconnected cleanly')
    process.exit(0)
  } catch (err) {
    const elapsed = Date.now() - t0
    console.error(`Failed after ${elapsed}ms:`, String(err).slice(0, 300))
    process.exit(1)
  }
})()
