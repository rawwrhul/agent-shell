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
