import { bootstrapSchedules } from '../src/scheduler'

;(async () => {
  console.log('Forcing schedule bootstrap...')
  await bootstrapSchedules()
  console.log('Done.')
  process.exit(0)
})().catch((err) => {
  console.error('bootstrap failed:', err)
  process.exit(1)
})
