/**
 * Phase 2 / Step 7 — Preview output shape with actual pending changes.
 *
 * Net-zero side effects:
 *   1. Confirm pending changes = 0
 *   2. Add a test item (slug=_test-cgs-agent-{ts}, never published)
 *   3. publishForAgent({ action: "preview" }) — log full output
 *   4. Remove the test item
 *   5. publishForAgent({ action: "preview" }) — confirm back to clean
 *
 * Never calls confirm_publish or deploy_to_production. Production untouched.
 *
 * Run: npx tsx scripts/framer-manual-tests/07-preview-with-changes.mts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

const TEST_SLUG = `_test-cgs-agent-${Date.now()}`;

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  // Pre-flight
  const initial = await f.getChangedPaths();
  const initialTotal =
    (initial?.added?.length ?? 0) +
    (initial?.removed?.length ?? 0) +
    (initial?.modified?.length ?? 0);
  if (initialTotal > 0) {
    console.error('[07] ABORT: pending changes already exist before we start.');
    console.error(JSON.stringify(initial, null, 2));
    process.exit(1);
  }
  console.log('[07] pre-flight clean: pending changes = 0');

  // Find Blog + resolve fields
  const collections = await f.getCollections();
  const blog = collections.find((c: any) => c.name === 'Blog');
  const fields = await blog.getFields();
  const byName: Record<string, any> = {};
  for (const fld of fields) byName[fld.name] = fld;
  const titleId = byName['Title'].id;
  const dateId = byName['Date'].id;
  const contentId = byName['Content'].id;

  // Add test item
  console.log(`\n[07] adding test item slug=${TEST_SLUG}...`);
  await blog.addItems([
    {
      slug: TEST_SLUG,
      fieldData: {
        [titleId]: { type: 'string', value: 'TEST POST — Phase 2 preview test. Safe to delete.' },
        [dateId]: { type: 'date', value: new Date().toISOString() },
        [contentId]: {
          type: 'formattedText',
          value: '<p dir="auto">Phase 2 preview-with-changes test post.</p>',
        },
      },
    },
  ]);

  // Preview with the pending change
  console.log('\n[07] calling publishForAgent({ action: "preview" }) WITH pending change...');
  const preview = await f.publishForAgent({ action: 'preview' });
  console.log(JSON.stringify(preview, null, 2));

  // Remove the test item
  const items = await blog.getItems();
  const created = items.find((i: any) => i.slug === TEST_SLUG);
  if (!created) {
    console.error('[07] FAIL: could not find the test item to remove.');
    process.exit(1);
  }
  console.log(`\n[07] removing test item ${created.id}...`);
  await blog.removeItems([created.id]);

  // Confirm preview is clean again
  console.log('\n[07] calling publishForAgent({ action: "preview" }) post-cleanup...');
  const postPreview = await f.publishForAgent({ action: 'preview' });
  console.log(`[07] post-cleanup changesCount: ${postPreview.changesCount}`);
  if (postPreview.changesCount !== 0) {
    console.error('[07] ⚠  changesCount is non-zero after cleanup. Inspect:');
    console.error(JSON.stringify(postPreview, null, 2));
  }

  if (typeof f.disconnect === 'function') {
    await f.disconnect();
  }
  console.log('\n[07] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[07] FAILED:', err);
  console.error(
    `[07] If a test item was created but not removed, search Tarino's Blog for slug starting with "_test-cgs-agent-" and delete manually.`
  );
  process.exit(1);
});
