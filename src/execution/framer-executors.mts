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
