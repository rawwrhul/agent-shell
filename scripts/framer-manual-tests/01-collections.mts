/**
 * Phase 2 / Step 1 — Collection discovery (READ-ONLY).
 *
 * Verifies:
 *   1. We can list collections in Tarino's project
 *   2. We can identify the blog collection by name
 *   3. We can read its field schema (the field name → ID mapping we need
 *      before any addItems call can succeed)
 *   4. We can fetch one or two existing items to confirm the fieldData shape
 *
 * Critically: also reports whether the blog collection has metaTitle /
 * metaDescription string fields — the Tarino-side prerequisite from Phase 1.
 *
 * Writes nothing.
 *
 * Run: npx tsx scripts/framer-manual-tests/01-collections.ts
 */
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

async function main() {
  const framer = await getFramerClient();
  const f = framer as any;

  const collections = await f.getCollections();
  console.log(`[01] found ${collections.length} collection(s):`);
  for (const c of collections) {
    console.log(`  - "${c.name}"  id=${c.id}  managedBy=${c.managedBy ?? 'unknown'}`);
  }

  if (collections.length === 0) {
    console.log('[01] no collections found — exit.');
    process.exit(0);
  }

  const blog =
    collections.find((c: any) => /blog|article|post|insight/i.test(c.name)) ??
    collections[0];
  console.log(`\n[01] inspecting: "${blog.name}" (id=${blog.id})`);

  // Field schema — try OO interface, fall back to bridge interface
  const fields = blog.getFields
    ? await blog.getFields()
    : await f.getCollectionFields(blog.id);
  console.log(`\n[01] fields (${fields.length}):`);
  for (const fld of fields) {
    console.log(`  - "${fld.name}"  id=${fld.id}  type=${fld.type}`);
  }

  // SEO prerequisite check
  const seoFieldNames = ['metaTitle', 'meta_title', 'metaDescription', 'meta_description'];
  const seoMatches = fields.filter((fld: any) =>
    seoFieldNames.some((target) =>
      String(fld.name).toLowerCase().replace(/[\s_-]/g, '') ===
      target.toLowerCase().replace(/[\s_-]/g, '')
    )
  );
  console.log(`\n[01] SEO meta fields found: ${seoMatches.length}`);
  for (const m of seoMatches) {
    console.log(`  - "${m.name}" (id=${m.id})`);
  }
  if (seoMatches.length < 2) {
    console.log('[01] ⚠  metaTitle/metaDescription not both present — Tarino-side');
    console.log('[01]    setup needed before agent can populate SEO meta.');
  }

  // Sample items
  const items = blog.getItems
    ? await blog.getItems()
    : await f.getCollectionItems(blog.id);
  console.log(`\n[01] items: ${items.length} total. Showing first 2:`);
  for (const item of items.slice(0, 2)) {
    console.log(JSON.stringify(item, null, 2).slice(0, 1500));
    console.log('---');
  }

  console.log('\n[01] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[01] FAILED:', err);
  process.exit(1);
});
