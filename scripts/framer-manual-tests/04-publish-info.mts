/**
 * Phase 2 / Step 4 — Publish info (READ-ONLY).
 *
 * Probes the remaining read-only publish-related methods to learn:
 *   1. The current staging URL (where publish() would put a preview)
 *   2. The current production URL (where deploy() would push to)
 *   3. When the last publish/deploy happened
 *
 * Calls NO write methods. Does not call publish(), does not call deploy().
 *
 * Run: npx tsx scripts/framer-manual-tests/04-publish-info.mts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

async function probe(framer: any, methodName: string, args: any[] = []) {
  console.log(`\n[04] ${methodName}(${args.length ? '...' : ''}) →`);
  try {
    const fn = framer[methodName];
    if (typeof fn !== 'function') {
      console.log(`  (not a function on this instance — skip)`);
      return;
    }
    const result = await fn.apply(framer, args);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`  threw: ${(e as Error).message}`);
  }
}

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  await probe(f, 'getPublishInfo');
  await probe(f, 'getProjectInfo');
  await probe(f, 'getCurrentUser');

  if (typeof f.disconnect === 'function') {
    await f.disconnect();
  }
  console.log('\n[04] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[04] FAILED:', err);
  process.exit(1);
});
