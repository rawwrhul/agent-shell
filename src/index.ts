import 'dotenv/config'
import { startAllTenantBots } from './tenants/slackManager'
import './queue/worker'
import { logger } from './logger'

import { bootstrapSchedules } from './scheduler'
import { startScheduleWorker } from './scheduler/worker'

import http from 'http'

import { startExecutionWorker } from './execution/worker';

async function main() {
  logger.info('cgs_agent_shell_starting', { env: process.env.NODE_ENV, pid: process.pid })
  await startAllTenantBots()
  await bootstrapSchedules()
  startScheduleWorker()

  const executionWorker = startExecutionWorker()
  logger.info('execution_worker_started', { queue: 'approval-execution' })

  process.on('SIGTERM', async () => {
    logger.info('shutdown_signal_received')
    try { await executionWorker.close() } catch {}
    process.exit(0)
  })

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
