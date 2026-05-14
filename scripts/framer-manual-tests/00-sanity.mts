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
import { getFramerClient } from '../../src/integrations/framer/client.mjs';

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
