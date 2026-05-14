/**
 * Phase 2 / Step 6 — Investigate publishForAgent (READ-ONLY probe first).
 *
 * The .d.ts docstring for publishForAgent describes an action-discriminated
 * input with "preview / confirm_publish / deploy_to_production" semantics.
 * That's the workflow we actually want.
 *
 * This script:
 *   1. Confirms publishForAgent exists on the runtime instance
 *   2. Calls it with NO arguments to see if it returns a default / dry-run
 *      result describing the expected input shape
 *   3. If that fails, calls it with { action: "preview" } as the most likely
 *      input shape based on the docstring
 *
 * If either call appears to perform a write (advancing publish info), we
 * abort the inspection.
 *
 * Run: npx tsx scripts/framer-manual-tests/06-publish-for-agent.mts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  if (typeof f.publishForAgent !== 'function') {
    console.error('[06] publishForAgent is not a function on this instance.');
    console.error('     Listing all *Agent* methods present:');
    for (const k in f) {
      if (/agent/i.test(k)) console.error('  -', k);
    }
    process.exit(1);
  }
  console.log('[06] ✓ publishForAgent exists.');

  // Snapshot publish info BEFORE any call
  const before = await f.getPublishInfo();
  console.log('[06] pre-call staging deploymentTime:', before.staging.deploymentTime);
  console.log('[06] pre-call production deploymentTime:', before.production.deploymentTime);

  // Attempt 1: no args
  console.log('\n[06] calling publishForAgent() with no args...');
  try {
    const r1 = await f.publishForAgent();
    console.log('[06] result:', JSON.stringify(r1, null, 2));
  } catch (e) {
    console.log('[06] threw:', (e as Error).message);
  }

  // Attempt 2: action: "preview"
  console.log('\n[06] calling publishForAgent({ action: "preview" })...');
  try {
    const r2 = await f.publishForAgent({ action: 'preview' });
    console.log('[06] result:', JSON.stringify(r2, null, 2));
  } catch (e) {
    console.log('[06] threw:', (e as Error).message);
  }

  // Snapshot publish info AFTER, alert if anything advanced
  const after = await f.getPublishInfo();
  console.log('\n[06] post-call staging deploymentTime:', after.staging.deploymentTime);
  console.log('[06] post-call production deploymentTime:', after.production.deploymentTime);

  if (after.production.deploymentTime !== before.production.deploymentTime) {
    console.error('[06] ⚠  production advanced — publishForAgent appears to have published.');
  }
  if (after.staging.deploymentTime !== before.staging.deploymentTime) {
    console.log('[06] note: staging advanced.');
  }

  if (typeof f.disconnect === 'function') {
    await f.disconnect();
  }
  console.log('\n[06] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[06] FAILED:', err);
  process.exit(1);
});
