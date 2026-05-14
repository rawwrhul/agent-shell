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
