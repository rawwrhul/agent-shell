import { enqueueOneOffRun } from '../src/scheduler'

;(async () => {
  const tenantId = 'tarino'
  for (const runKind of ['seo_audit', 'backlink_prospect', 'brand_mention_scan'] as const) {
    await enqueueOneOffRun({ tenantId, runKind })
    console.log('queued', runKind)
  }
  process.exit(0)
})()
