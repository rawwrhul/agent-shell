/**
 * Phase 2 / Step 3 — Deployments + changed paths (READ-ONLY).
 *
 * Verifies:
 *   1. framer.getDeployments() works and returns the existing deployment list
 *   2. framer.getChangedPaths() works and reports the diff vs current state
 *
 * Critically: changes nothing. This is the gate before we attempt publish().
 *
 * What we're looking for:
 *   - Existing deployments (so we know what URL pattern publish() produces)
 *   - Whether getChangedPaths() shows a LOT of pending changes
 *     (if yes, calling publish() later would bundle them into our test
 *     deployment — we'd want to understand them before proceeding)
 *
 * Run: npx tsx scripts/framer-manual-tests/03-deployments.mts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  // 1. Existing deployments
  console.log('[03] fetching existing deployments...');
  let deployments: any[] = [];
  try {
    deployments = await f.getDeployments();
    console.log(`[03] found ${deployments.length} deployment(s):`);
    for (const d of deployments.slice(0, 10)) {
      console.log(JSON.stringify(d, null, 2));
      console.log('---');
    }
    if (deployments.length > 10) {
      console.log(`[03] ... and ${deployments.length - 10} more.`);
    }
  } catch (e) {
    console.error('[03] getDeployments threw:', (e as Error).message);
  }

  // 2. Changed paths since last deploy
  console.log('\n[03] fetching changed paths since last deployment...');
  try {
    const changed = await f.getChangedPaths();
    console.log('[03] getChangedPaths result:');
    console.log(JSON.stringify(changed, null, 2));
    const total =
      (changed?.added?.length ?? 0) +
      (changed?.removed?.length ?? 0) +
      (changed?.modified?.length ?? 0);
    console.log(`[03] total changes pending: ${total}`);
    if (total > 0) {
      console.log('[03] ⚠  there ARE pending changes — calling publish() would');
      console.log('       bundle them into the staging deployment. Review the list');
      console.log('       above before proceeding to a publish test.');
    } else {
      console.log('[03] ✓ no pending changes — publish() would be a no-op snapshot.');
    }
  } catch (e) {
    console.error('[03] getChangedPaths threw:', (e as Error).message);
  }

  if (typeof f.disconnect === 'function') {
    await f.disconnect();
  }
  console.log('\n[03] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[03] FAILED:', err);
  process.exit(1);
});
