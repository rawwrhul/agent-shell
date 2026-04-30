import 'dotenv/config'
import { startAllTenantBots } from './tenants/slackManager'
import './queue/worker'
import { logger } from './logger'

async function main() {
  logger.info('cgs_agent_shell_starting', { env: process.env.NODE_ENV, pid: process.pid })
  await startAllTenantBots()
  logger.info('cgs_agent_shell_ready', { mode: 'multi-tenant' })
}

main().catch(err => {
  logger.error('startup_failed', { err: err.message })
  process.exit(1)
})
