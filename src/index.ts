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

// Phase 9f: process-level safety net for @slack/socket-mode state-machine
// noise. The finity state machine inside @slack/socket-mode throws when it
// receives a 'server explicit disconnect' event during the 'connecting'
// state — a real production pattern we've observed. Without these handlers
// Node kills the process, Cloud Run restarts, and we crash-loop.
//
// We deliberately do NOT call process.exit here. The errors we're catching
// don't corrupt process state — they leave the rest of the runtime healthy
// and the socket lib will reconnect on its own. Genuinely fatal errors
// (OOM, etc.) still get caught by Cloud Run's underlying restart-on-crash.
process.on('uncaughtException', (err: Error) => {
  logger.error('uncaught_exception', {
    msg:   err.message,
    stack: err.stack?.slice(0, 1500),
  })
})

process.on('unhandledRejection', (reason: unknown) => {
  logger.error('unhandled_rejection', {
    reason: String(reason).slice(0, 1500),
  })
})

main().catch(err => {
  logger.error('startup_failed', { err: err.message })
  process.exit(1)
})
