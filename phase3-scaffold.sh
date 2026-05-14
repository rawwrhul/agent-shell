#!/usr/bin/env bash
# phase3-scaffold.sh
#
# Builds Phase 3 of the Framer integration:
#   - src/integrations/framer/types.mts     (domain types)
#   - src/integrations/framer/blog.mts      (domain functions)
#   - src/execution/framer-executors.mts    (executor wrappers — adapt to your dispatcher)
#   - scripts/framer-manual-tests/08-integration.mts  (E2E test, net-zero)
#
# Run from the agent-shell-v3 project root.

set -euo pipefail

mkdir -p src/integrations/framer
mkdir -p src/execution
mkdir -p scripts/framer-manual-tests

# --- src/integrations/framer/types.mts ----------------------------------------
cat > src/integrations/framer/types.mts << 'TS_EOF'
/**
 * Domain types for the Framer Blog integration.
 *
 * Locally defined rather than imported from `framer-api` so the integration
 * module stays decoupled from the SDK's evolving .d.ts.
 */

export interface BlogPostDraft {
  /** URL-safe identifier. Must be unique within the Blog collection. */
  slug: string;
  /** Plain-text title. */
  title: string;
  /** HTML body — Framer's `formattedText` format (e.g. <p>, <h2>, <strong>). */
  content: string;
  /** ISO-8601 date. Defaults to now if omitted. */
  date?: string;
}

export interface FramerPreviewChange {
  type: string;
  nodeId: string;
  name: string;
  status: 'added' | 'modified' | 'removed' | string;
}

export interface FramerPreviewResult {
  action: 'preview';
  status: string;
  message: string;
  stagingEnabled: boolean;
  confirmationHash: string;
  errors: unknown[];
  warnings: unknown[];
  changes: FramerPreviewChange[];
  changesCount: number;
  urls: { production: string };
  nextAction: { type: string; confirmationHash: string };
}

export interface FramerConfirmResult {
  action: 'confirm_publish';
  status: string;
  message?: string;
  deployment?: { id: string };
  // Full shape is partially unknown until we exercise confirm_publish with
  // a real change set. Loosely typed for now.
  [key: string]: unknown;
}

/**
 * Output of draftAndPreview — the payload the approval card consumes.
 *
 * Persist `itemId` and `preview.confirmationHash` on the approval row so
 * the commit step (confirmPublish) and the rollback step (removeBlogPost)
 * have what they need.
 */
export interface DraftAndPreviewResult {
  itemId: string;
  post: BlogPostDraft;
  preview: FramerPreviewResult;
}
TS_EOF

# --- src/integrations/framer/blog.mts -----------------------------------------
cat > src/integrations/framer/blog.mts << 'TS_EOF'
/**
 * Framer Blog integration — domain functions.
 *
 * These are pure async functions over an already-connected `framer` instance
 * (use withFramerSession to manage the connection).
 *
 * Surface for the executor layer:
 *   - draftAndPreview(framer, post)  → creates the item + runs preview
 *   - confirmPublish(framer, hash)   → commits a previously-previewed change set
 *   - removeBlogPost(framer, itemId) → rollback on rejection
 */
import { connect } from 'framer-api';
import type {
  BlogPostDraft,
  DraftAndPreviewResult,
  FramerConfirmResult,
  FramerPreviewResult,
} from './types.mjs';

const BLOG_COLLECTION_NAME = 'Blog';

function getFramerConfig() {
  const projectUrl = process.env.FRAMER_PROJECT_URL;
  const token = process.env.FRAMER_TOKEN;
  if (!projectUrl) throw new Error('FRAMER_PROJECT_URL env var is required');
  if (!token) throw new Error('FRAMER_TOKEN env var is required');
  return { projectUrl, token };
}

/**
 * Connect to Framer, run `fn`, disconnect. Use for one-shot operations.
 */
export async function withFramerSession<T>(
  fn: (framer: any) => Promise<T>
): Promise<T> {
  const { projectUrl, token } = getFramerConfig();
  const framer = await connect(projectUrl, token);
  try {
    return await fn(framer);
  } finally {
    if (typeof (framer as any).disconnect === 'function') {
      await (framer as any).disconnect();
    }
  }
}

/**
 * Find Tarino's Blog collection by name. Throws if not found.
 */
export async function findBlogCollection(framer: any) {
  const collections = await framer.getCollections();
  const blog = collections.find((c: any) => c.name === BLOG_COLLECTION_NAME);
  if (!blog) {
    throw new Error(
      `No collection named "${BLOG_COLLECTION_NAME}" found in this project.`
    );
  }
  return blog;
}

/**
 * Resolve field name → ID for the Blog schema. Done at runtime to survive
 * schema edits in Framer's UI.
 */
export async function resolveBlogFieldIds(blog: any): Promise<{
  titleId: string;
  dateId: string;
  contentId: string;
}> {
  const fields = await blog.getFields();
  const byName: Record<string, any> = {};
  for (const fld of fields) byName[fld.name] = fld;
  const titleId = byName['Title']?.id;
  const dateId = byName['Date']?.id;
  const contentId = byName['Content']?.id;
  if (!titleId || !dateId || !contentId) {
    throw new Error(
      `Blog schema missing required field. Available: ${Object.keys(byName).join(', ')}`
    );
  }
  return { titleId, dateId, contentId };
}

/**
 * Count pending changes since the last publish. Used for preflight.
 */
export async function getPendingChangesCount(framer: any): Promise<number> {
  const changed = await framer.getChangedPaths();
  return (
    (changed?.added?.length ?? 0) +
    (changed?.removed?.length ?? 0) +
    (changed?.modified?.length ?? 0)
  );
}

/**
 * Create a single blog post item. Returns the new CollectionItem ID.
 */
export async function createBlogPost(
  framer: any,
  post: BlogPostDraft
): Promise<string> {
  const blog = await findBlogCollection(framer);
  const { titleId, dateId, contentId } = await resolveBlogFieldIds(blog);

  await blog.addItems([
    {
      slug: post.slug,
      fieldData: {
        [titleId]: { type: 'string', value: post.title },
        [dateId]: { type: 'date', value: post.date ?? new Date().toISOString() },
        [contentId]: { type: 'formattedText', value: post.content },
      },
    },
  ]);

  const items = await blog.getItems();
  const created = items.find((i: any) => i.slug === post.slug);
  if (!created) {
    throw new Error(
      `addItems succeeded but item with slug "${post.slug}" not found on read-back.`
    );
  }
  return created.id;
}

/**
 * Remove a blog post by ID. Used for rollback.
 */
export async function removeBlogPost(framer: any, itemId: string): Promise<void> {
  const blog = await findBlogCollection(framer);
  await blog.removeItems([itemId]);
}

/**
 * Run the preview action. Pure dry-run — does not advance deploymentTime.
 */
export async function previewPublish(framer: any): Promise<FramerPreviewResult> {
  const result = await framer.publishForAgent({ action: 'preview' });
  return result as FramerPreviewResult;
}

/**
 * Commit a previously-previewed change set. Requires the confirmationHash
 * returned by previewPublish().
 *
 * This is the only write action that actually publishes to production.
 * Gate every call through an approval flow.
 */
export async function confirmPublish(
  framer: any,
  confirmationHash: string
): Promise<FramerConfirmResult> {
  if (!confirmationHash) {
    throw new Error('confirmPublish requires a confirmationHash');
  }
  const result = await framer.publishForAgent({
    action: 'confirm_publish',
    confirmationHash,
  });
  return result as FramerConfirmResult;
}

/**
 * Full draft-and-preview flow. Returns the approval card payload.
 *
 * Preflight: refuses to proceed if the workspace has existing pending changes
 * (we don't want to commit unrelated edits along with the agent's post).
 *
 * Failure handling: if previewPublish fails after the item is created, the
 * item is rolled back so we don't leave orphaned drafts in the workspace.
 */
export async function draftAndPreview(
  framer: any,
  post: BlogPostDraft
): Promise<DraftAndPreviewResult> {
  const pending = await getPendingChangesCount(framer);
  if (pending > 0) {
    throw new Error(
      `Refusing to draft: ${pending} pending change(s) already exist in the workspace. ` +
        `Clear them in Framer's UI (publish or revert) before drafting.`
    );
  }

  const itemId = await createBlogPost(framer, post);

  let preview: FramerPreviewResult;
  try {
    preview = await previewPublish(framer);
  } catch (err) {
    try {
      await removeBlogPost(framer, itemId);
    } catch (rollbackErr) {
      throw new Error(
        `previewPublish failed and rollback also failed.\n` +
          `Original: ${(err as Error).message}\n` +
          `Rollback: ${(rollbackErr as Error).message}`
      );
    }
    throw err;
  }

  return { itemId, post, preview };
}
TS_EOF

# --- src/execution/framer-executors.mts ---------------------------------------
cat > src/execution/framer-executors.mts << 'TS_EOF'
/**
 * Framer executor wrappers.
 *
 * Wire these into your EXECUTOR_REGISTRY. The exact function signature here
 * (input, context) is generic — adapt to match your dispatcher's contract.
 * The domain logic in withFramerSession is the part that matters.
 *
 * Example registration:
 *
 *   import {
 *     execFramerDraftBlogPost,
 *     execFramerConfirmPublish,
 *     execFramerRollbackDraft,
 *   } from './framer-executors.mjs';
 *
 *   EXECUTOR_REGISTRY = {
 *     framer_draft_blog_post: execFramerDraftBlogPost,
 *     framer_confirm_publish: execFramerConfirmPublish,
 *     framer_rollback_draft:  execFramerRollbackDraft,
 *   };
 *
 * Persist on the approval row when the agent calls propose_action:
 *   - itemId from execFramerDraftBlogPost.result.itemId
 *   - confirmationHash from execFramerDraftBlogPost.result.preview.confirmationHash
 *
 * On approval: invoke execFramerConfirmPublish with { confirmationHash }.
 * On rejection: invoke execFramerRollbackDraft with { itemId }.
 */
import {
  withFramerSession,
  draftAndPreview,
  confirmPublish,
  removeBlogPost,
} from '../integrations/framer/blog.mjs';
import type {
  BlogPostDraft,
  DraftAndPreviewResult,
  FramerConfirmResult,
} from '../integrations/framer/types.mjs';

export interface DraftBlogPostInput {
  slug: string;
  title: string;
  content: string;
  date?: string;
}

export interface ConfirmPublishInput {
  confirmationHash: string;
}

export interface RollbackDraftInput {
  itemId: string;
}

export async function execFramerDraftBlogPost(
  input: DraftBlogPostInput,
  _context?: unknown
): Promise<DraftAndPreviewResult> {
  return withFramerSession((framer) =>
    draftAndPreview(framer, input as BlogPostDraft)
  );
}

export async function execFramerConfirmPublish(
  input: ConfirmPublishInput,
  _context?: unknown
): Promise<FramerConfirmResult> {
  return withFramerSession((framer) =>
    confirmPublish(framer, input.confirmationHash)
  );
}

export async function execFramerRollbackDraft(
  input: RollbackDraftInput,
  _context?: unknown
): Promise<{ rolledBack: true; itemId: string }> {
  return withFramerSession(async (framer) => {
    await removeBlogPost(framer, input.itemId);
    return { rolledBack: true as const, itemId: input.itemId };
  });
}
TS_EOF

# --- scripts/framer-manual-tests/08-integration.mts ---------------------------
cat > scripts/framer-manual-tests/08-integration.mts << 'TS_EOF'
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
TS_EOF

echo ""
echo "✓ Phase 3 scaffolding created:"
echo "  - src/integrations/framer/types.mts"
echo "  - src/integrations/framer/blog.mts"
echo "  - src/execution/framer-executors.mts"
echo "  - scripts/framer-manual-tests/08-integration.mts"
echo ""
echo "Next steps:"
echo "  1. Load env vars (if you don't already have them):"
echo "       set -a; source .env.framer.local; set +a"
echo ""
echo "  2. Run the end-to-end integration test:"
echo "       npx tsx scripts/framer-manual-tests/08-integration.mts"
echo ""
echo "  3. If 08 passes, wire the executors into your dispatcher:"
echo "       - Import from src/execution/framer-executors.mts"
echo "       - Register framer_draft_blog_post / framer_confirm_publish / framer_rollback_draft"
echo "       - Persist itemId and confirmationHash on the approval row"
echo "       - Wire the approval-row state machine: approved → confirm_publish, rejected → rollback"
