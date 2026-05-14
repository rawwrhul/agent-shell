/**
 * Phase 3 / Step 8 — End-to-end integration test of the Blog domain module.
 *
 * Runs the full draft → preview → rollback flow using the new module's API,
 * without ever calling confirm_publish. Net-zero side effects.
 *
 * This is also the Phase 4 isolation test — exercises the executor layer
 * end-to-end without involving the dispatcher, queue, or Slack.
 *
 * Run: npx tsx scripts/framer-manual-tests/08-integration.mts
 */
import {
  withFramerSession,
  draftAndPreview,
  removeBlogPost,
  getPendingChangesCount,
} from '../../src/integrations/framer/blog.mjs';

async function main() {
  await withFramerSession(async (framer) => {
    const slug = `_test-cgs-agent-${Date.now()}`;

    console.log('[08] running draftAndPreview...');
    const result = await draftAndPreview(framer, {
      slug,
      title: 'TEST POST — Phase 3 integration test. Safe to delete.',
      content:
        '<p dir="auto">Phase 3 integration test of the Framer Blog module. Created and removed by the same script run.</p>',
    });

    console.log(`[08] ✓ itemId: ${result.itemId}`);
    console.log(`[08] ✓ confirmationHash: ${result.preview.confirmationHash}`);
    console.log(`[08] ✓ changesCount: ${result.preview.changesCount}`);
    console.log(`[08] ✓ warnings: ${result.preview.warnings.length}, errors: ${result.preview.errors.length}`);
    console.log('\n[08] full approval-card payload:');
    console.log(JSON.stringify(result, null, 2));

    console.log(`\n[08] rolling back item ${result.itemId}...`);
    await removeBlogPost(framer, result.itemId);

    const finalPending = await getPendingChangesCount(framer);
    console.log(`[08] pending changes after rollback: ${finalPending}`);
    if (finalPending !== 0) {
      console.error('[08] ⚠  pending changes non-zero after rollback. Investigate.');
      process.exit(1);
    }
    console.log('[08] ✓ clean state restored.');
  });

  console.log('\n[08] ✓ done');
  process.exit(0);
}

main().catch((err) => {
  console.error('[08] FAILED:', err);
  process.exit(1);
});
