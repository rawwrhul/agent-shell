import { Pool } from 'pg'
import { config } from '../src/config'
import { onApprovalApproved } from '../src/hitl/execution-hook'

;(async () => {
  const pool = new Pool({ connectionString: config.DATABASE_URL })

  const { rows } = await pool.query(
    `SELECT id, tool_name, executed_outcome
     FROM approval_requests 
     WHERE tenant_id = 'tarino' 
       AND requested_at > NOW() - INTERVAL '3 days'
       AND status = 'approved'
       AND executed_outcome ILIKE 'failed%'`
  )

  if (rows.length === 0) {
    console.log('No failed approvals to retry.')
    process.exit(0)
  }

  console.log(`Found ${rows.length} failed approvals:`)
  for (const r of rows) {
    console.log(`  ${r.tool_name} (${r.id}) - ${String(r.executed_outcome).slice(0, 80)}`)
  }

  await pool.query(
    `UPDATE approval_requests 
     SET executed_at = NULL, executed_outcome = NULL
     WHERE id = ANY($1)`,
    [rows.map(r => r.id)]
  )
  console.log(`\nReset ${rows.length} approvals. Re-enqueuing...`)

  for (const r of rows) {
    const result = await onApprovalApproved(r.id)
    console.log(`  ${r.tool_name}: ${JSON.stringify(result)}`)
  }

  console.log('\nDone. Watch Cloud Run logs for execution.')
  process.exit(0)
})().catch((err) => {
  console.error('retry failed:', err)
  process.exit(1)
})
