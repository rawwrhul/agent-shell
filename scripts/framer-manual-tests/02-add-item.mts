/**
 * Phase 2 / Step 2 — Write + cleanup test (CREATES AND DELETES one item).
 *
 * Verifies:
 *   1. Collection.addItems works against Tarino's real Blog collection
 *   2. The fieldData shape we inferred from 01-collections is accepted
 *   3. Collection.removeItems works for cleanup
 *
 * Workflow:
 *   - Look up the Blog collection by name
 *   - Resolve field name → ID at runtime (no hardcoded IDs)
 *   - addItems([{ slug, fieldData }]) with an obvious test slug
 *   - getItems() to confirm the new item is there
 *   - removeItems([id]) to clean up
 *   - getItems() again to confirm it's gone
 *
 * Never calls publish() or deploy(), so nothing ever goes live on tarino.au.
 *
 * Run: npx tsx scripts/framer-manual-tests/02-add-item.mts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

const TEST_SLUG = `_test-cgs-agent-${Date.now()}`;

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  // 1. Find Blog
  const collections = await f.getCollections();
  const blog = collections.find((c: any) => c.name === 'Blog');
  if (!blog) {
    console.error('[02] FAIL: no collection named "Blog".');
    process.exit(1);
  }
  console.log(`[02] target: "${blog.name}" (id=${blog.id})`);

  // 2. Resolve field IDs
  const fields = blog.getFields
    ? await blog.getFields()
    : await f.getCollectionFields(blog.id);
  const byName: Record<string, any> = {};
  for (const fld of fields) byName[fld.name] = fld;

  const titleId = byName['Title']?.id;
  const dateId = byName['Date']?.id;
  const contentId = byName['Content']?.id;
  if (!titleId || !dateId || !contentId) {
    console.error('[02] FAIL: missing Title/Date/Content field.');
    console.error('       available fields:', Object.keys(byName));
    process.exit(1);
  }

  // 3. Build the test item (image omitted — test whether it's required)
  const fieldData = {
    [titleId]: {
      type: 'string',
      value: 'TEST POST — created by agent-shell-v3 Phase 2 manual test. Safe to delete.',
    },
    [dateId]: {
      type: 'date',
      value: new Date().toISOString(),
    },
    [contentId]: {
      type: 'formattedText',
      value:
        '<p dir="auto">This is a Phase 2 manual test post. It should be deleted automatically by the same script that created it.</p>',
    },
  };

  // 4. Create
  console.log(`[02] creating item with slug=${TEST_SLUG}...`);
  if (blog.addItems) {
    await blog.addItems([{ slug: TEST_SLUG, fieldData }]);
  } else {
    await f.addCollectionItems(blog.id, [{ slug: TEST_SLUG, fieldData }]);
  }
  console.log('[02] addItems returned without throwing.');

  // 5. Verify created
  const items = blog.getItems
    ? await blog.getItems()
    : await f.getCollectionItems(blog.id);
  const created = items.find((i: any) => i.slug === TEST_SLUG);
  if (!created) {
    console.error(
      `[02] FAIL: addItems succeeded but slug=${TEST_SLUG} not found on read-back.`
    );
    process.exit(1);
  }
  console.log(`[02] ✓ created: id=${created.id}, slug=${created.slug}`);

  // 6. Remove
  console.log(`[02] removing item ${created.id}...`);
  if (blog.removeItems) {
    await blog.removeItems([created.id]);
  } else {
    await f.removeCollectionItems([created.id]);
  }
  console.log('[02] removeItems returned without throwing.');

  // 7. Verify removed
  const itemsAfter = blog.getItems
    ? await blog.getItems()
    : await f.getCollectionItems(blog.id);
  const stillThere = itemsAfter.find((i: any) => i.slug === TEST_SLUG);
  if (stillThere) {
    console.error('[02] ⚠  WARNING: item still present after removeItems.');
    console.error(`       Manually remove slug=${TEST_SLUG} (id=${created.id}) in Framer.`);
    process.exit(1);
  }
  console.log('[02] ✓ removed and verified.');

  if (typeof (framer as any).disconnect === 'function') {
    await (framer as any).disconnect();
  }
  console.log('[02] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[02] FAILED:', err);
  console.error(
    `[02] If a test item was created but not removed, search Tarino's Blog for slug starting with "_test-cgs-agent-" and delete it manually.`
  );
  process.exit(1);
});
