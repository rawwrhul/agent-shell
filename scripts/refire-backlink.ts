import { enqueueOneOffRun } from '../src/scheduler'
;(async () => {
  await enqueueOneOffRun({ tenantId: 'tarino', runKind: 'backlink_prospect' })
  console.log('queued')
  process.exit(0)
})()
