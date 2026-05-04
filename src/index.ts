import 'dotenv/config'
import { startAllTenantBots } from './tenants/slackManager'
import './queue/worker'
import { logger } from './logger'
import http from 'http'

async function main() {
  logger.info('cgs_agent_shell_starting', { env: process.env.NODE_ENV, pid: process.pid })
  await startAllTenantBots()
  logger.info('cgs_agent_shell_ready', { mode: 'multi-tenant' })
}

// Health check server for Cloud Run
const server = http.createServer((req, res) => {
  res.writeHead(200)
  res.end('OK')
})
server.listen(process.env.PORT || 3000)

main().catch(err => {
  logger.error('startup_failed', { err: err.message })
  process.exit(1)
})
