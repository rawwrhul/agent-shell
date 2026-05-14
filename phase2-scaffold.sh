#!/usr/bin/env bash
# phase2-scaffold.sh
#
# Scaffolds Phase 2 manual-test infrastructure for the Framer integration.
# Creates a thin client wrapper and two read-only test scripts that hit
# Tarino's real project — but never via Slack, the agent, or the executor.
#
# Run from the agent-shell-v3 project root.

set -euo pipefail

mkdir -p src/integrations/framer
mkdir -p scripts/framer-manual-tests

# --- src/integrations/framer/client.ts ----------------------------------------
cat > src/integrations/framer/client.ts << 'TS_EOF'
import { connect } from 'framer-api';

export function getFramerConfig() {
  const projectUrl = process.env.FRAMER_PROJECT_URL;
  const token = process.env.FRAMER_TOKEN;
  if (!projectUrl) throw new Error('FRAMER_PROJECT_URL env var is required');
  if (!token) throw new Error('FRAMER_TOKEN env var is required');
  return { projectUrl, token };
}

export async function getFramerClient() {
  const { projectUrl, token } = getFramerConfig();
  return connect(projectUrl, token);
}
TS_EOF

# --- scripts/framer-manual-tests/00-sanity.ts ---------------------------------
cat > scripts/framer-manual-tests/00-sanity.ts << 'TS_EOF'
/**
 * Phase 2 / Step 0 — Sanity check.
 *
 * Verifies that connect() works from Node.js and the token is valid.
 * Reads nothing from Tarino's content, writes nothing.
 *
 * THE big unknown this resolves: framer-api is the Framer Plugin SDK, which
 * MAY require a Framer plugin iframe runtime. The top-level connect() function
 * suggests it also supports a standalone client mode — but we don't know until
 * we try.
 *
 * Run: npx tsx scripts/framer-manual-tests/00-sanity.ts
 */
import { getFramerClient } from '../../src/integrations/framer/client';

async function main() {
  console.log('[00] connecting to Framer...');
  const framer = await getFramerClient();
  console.log('[00] connected.');

  const proto = Object.getPrototypeOf(framer);
  const methods = Object.getOwnPropertyNames(proto)
    .filter((n) => typeof (framer as any)[n] === 'function' && !n.startsWith('_'));
  console.log(`[00] framer instance exposes ${methods.length} methods.`);
  console.log('[00] first 30:', methods.slice(0, 30));

  // Probe synchronous properties
  for (const prop of ['mode', 'isAllowedTo']) {
    try {
      const v = (framer as any)[prop];
      const desc = typeof v === 'function' ? 'function' : JSON.stringify(v);
      console.log(`[00] framer.${prop}:`, desc);
    } catch (e) {
      console.log(`[00] framer.${prop} threw:`, (e as Error).message);
    }
  }

  // Find cleanup method (we don't know which name applies)
  const cleanupCandidates = ['disconnect', 'closePlugin', 'destroy', 'close'].filter(
    (m) => typeof (framer as any)[m] === 'function'
  );
  console.log('[00] cleanup methods available:', cleanupCandidates);

  console.log('[00] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[00] FAILED:', err);
  process.exit(1);
});
TS_EOF

# --- scripts/framer-manual-tests/01-collections.ts ----------------------------
cat > scripts/framer-manual-tests/01-collections.ts << 'TS_EOF'
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
import { getFramerClient } from '../../src/integrations/framer/client';

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
TS_EOF

# --- .env.framer.example ------------------------------------------------------
cat > .env.framer.example << 'ENV_EOF'
# Phase 2 manual-test config for the Framer integration.
# Copy to .env.framer.local and fill in. DO NOT commit .env.framer.local.
FRAMER_PROJECT_URL=
FRAMER_TOKEN=
ENV_EOF

# --- .gitignore sanity check --------------------------------------------------
if [ -f .gitignore ] && ! grep -q "^\.env\.framer\.local$" .gitignore; then
  echo ".env.framer.local" >> .gitignore
  echo "→ added .env.framer.local to .gitignore"
fi

echo ""
echo "✓ Scaffolding created:"
echo "  - src/integrations/framer/client.ts"
echo "  - scripts/framer-manual-tests/00-sanity.ts"
echo "  - scripts/framer-manual-tests/01-collections.ts"
echo "  - .env.framer.example"
echo ""
echo "Next steps:"
echo "  1. cp .env.framer.example .env.framer.local"
echo "  2. Fill in FRAMER_PROJECT_URL and FRAMER_TOKEN from 1Password"
echo "  3. Run the sanity check:"
echo ""
echo "       set -a; source .env.framer.local; set +a"
echo "       npx tsx scripts/framer-manual-tests/00-sanity.ts"
echo ""
echo "  4. STOP if 00 fails. Paste the error before running 01."
echo "  5. If 00 passes, run:"
echo "       npx tsx scripts/framer-manual-tests/01-collections.ts"
