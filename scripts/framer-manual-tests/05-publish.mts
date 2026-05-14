/**
 * Phase 2 / Step 5 — publish() test (TOUCHES STAGING; does NOT touch production).
 *
 * Defensive workflow:
 *   1. Re-check getChangedPaths() — if non-zero, ABORT.
 *      (We never want to publish unexpected pending changes.)
 *   2. Capture pre-publish publish info (staging deploymentTime).
 *   3. Call publish() and log the full PublishResult.
 *   4. Re-fetch publish info; confirm staging deploymentTime advanced.
 *   5. Confirm production deploymentTime is UNCHANGED.
 *
 * Outcome on success: a new staging deployment exists at
 * https://novel-eyes-714446.framer.app — identical content to before since
 * pending changes were zero. Production (tarino.au) is untouched.
 *
 * Run: npx tsx scripts/framer-manual-tests/05-publish.mts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  // 1. Defensive: re-check changed paths
  const changed = await f.getChangedPaths();
  const total =
    (changed?.added?.length ?? 0) +
    (changed?.removed?.length ?? 0) +
    (changed?.modified?.length ?? 0);
  console.log(`[05] pending changes: ${total}`);
  if (total > 0) {
    console.error('[05] ABORT: pending changes detected — refusing to publish.');
    console.error(JSON.stringify(changed, null, 2));
    process.exit(1);
  }

  // 2. Pre-publish snapshot of publish info
  const before = await f.getPublishInfo();
  console.log('[05] pre-publish staging deploymentTime:', before.staging.deploymentTime);
  console.log('[05] pre-publish production deploymentTime:', before.production.deploymentTime);

  // 3. publish()
  console.log('[05] calling publish()...');
  const result = await f.publish();
  console.log('[05] publish() returned:');
  console.log(JSON.stringify(result, null, 2));

  // 4. Verify staging advanced
  const after = await f.getPublishInfo();
  console.log('\n[05] post-publish staging deploymentTime:', after.staging.deploymentTime);
  console.log('[05] post-publish production deploymentTime:', after.production.deploymentTime);

  const stagingAdvanced = after.staging.deploymentTime !== before.staging.deploymentTime;
  const productionUnchanged =
    after.production.deploymentTime === before.production.deploymentTime;

  console.log(`\n[05] staging advanced: ${stagingAdvanced}`);
  console.log(`[05] production unchanged: ${productionUnchanged}`);

  if (!stagingAdvanced) {
    console.error('[05] ⚠  staging deploymentTime did NOT advance — publish may have been a no-op.');
  }
  if (!productionUnchanged) {
    console.error('[05] ⚠  production deploymentTime CHANGED — this should NOT happen from publish().');
    console.error('[05]    investigate immediately.');
    process.exit(1);
  }

  if (typeof f.disconnect === 'function') {
    await f.disconnect();
  }
  console.log('\n[05] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[05] FAILED:', err);
  process.exit(1);
});
