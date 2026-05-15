import { Pool } from 'pg'
import { listBlogItems } from '../src/integrations/framer/client'
import type { TenantConfig } from '../src/tenants/types'

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const { rows } = await pool.query<{ client_name: string; framer_project_url: string }>(
    `SELECT client_name, framer_project_url FROM tenants WHERE tenant_id='tarino'`,
  )
  await pool.end()
  const tenant = { tenantId: 'tarino', clientName: rows[0].client_name, framer_project_url: rows[0].framer_project_url } as unknown as TenantConfig
  const items = await listBlogItems(tenant)
  console.log(`${items.length} items:`)
  items.forEach(i => console.log(`  ${i.slug.padEnd(45)} draft=${(i as any).draft ?? 'unknown'} id=${i.id}`))
}
main().catch(e => { console.error(e); process.exit(1) })
