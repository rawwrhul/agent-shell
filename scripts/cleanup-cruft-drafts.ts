import { Pool } from 'pg'
import { withFramerSession, removeBlogPost, listBlogItems } from '../src/integrations/framer/client'
import type { TenantConfig } from '../src/tenants/types'

const SLUGS_TO_REMOVE = ['schema-markup-homepage-install', 'internal-linking-audit-may-2026']

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const { rows } = await pool.query<{ client_name: string; framer_project_url: string }>(
    `SELECT client_name, framer_project_url FROM tenants WHERE tenant_id='tarino'`,
  )
  await pool.end()
  const tenant = { tenantId: 'tarino', clientName: rows[0].client_name, framer_project_url: rows[0].framer_project_url } as unknown as TenantConfig

  const items = await listBlogItems(tenant)
  for (const slug of SLUGS_TO_REMOVE) {
    const match = items.find(i => i.slug === slug)
    if (!match) { console.log(`${slug}: not found in CMS`); continue }
    console.log(`removing ${slug} (id=${match.id})...`)
    const result = await removeBlogPost(tenant, match.id)
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.summary}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
