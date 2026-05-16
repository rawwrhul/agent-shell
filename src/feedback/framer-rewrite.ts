// src/feedback/framer-rewrite.ts
//
// Helper for Stage 2 refinements: remove the existing Framer draft and
// re-create it with refined content. The Framer SDK we wrap doesn't expose
// an in-place setFieldValues operation, so remove + add is the pattern
// that uses methods we know work (already used elsewhere in client.ts).
//
// Side effect: itemId CHANGES. The Stage 2 approval row's tool_input must
// be updated with the new itemId + confirmationHash, and any Slack message
// referencing the old preview URL becomes stale (we post a fresh URL in the
// thread reply).

import * as fr from '../integrations/framer/client'
import type { TenantConfig } from '../tenants/types'

export interface RewriteInput {
  tenant:   TenantConfig
  oldItemId: string
  slug:     string
  title:    string
  content:  string
  date?:    string
  imageUrl?: string
}

export interface RewriteResult {
  newItemId:        string
  confirmationHash: string
}

/**
 * Replace an existing Blog item with refined content. Performs:
 *   1. removeItems([oldItemId])
 *   2. addItems([{slug, fieldData with refined values}])
 *   3. publishForAgent({action: 'preview'}) → new confirmationHash
 *
 * Returns the new itemId + confirmationHash for the caller to write back
 * to the Stage 2 approval row.
 *
 * Caveat: this happens in two separate Framer SDK calls (remove via
 * removeBlogPost, then add via draftAndPreviewBlogPost). draftAndPreviewBlogPost
 * has a preflight check that refuses if pending changes exist in the
 * workspace — but the remove we just did IS a pending change, so we have
 * to use a lower-level path or accept that quirk. Below uses the public
 * helpers and works because removeItems doesn't register as a workspace
 * 'change' in the same way addItems does until a publishForAgent fires.
 */
export async function rewriteBlogItem(input: RewriteInput): Promise<RewriteResult> {
  // 1. Remove the old item
  await fr.removeBlogPost(input.tenant, input.oldItemId)

  // 2. Re-add with refined content. Reuses the existing draft helper which
  //    also runs preview and returns the new confirmationHash.
  const draft = await fr.draftAndPreviewBlogPost(input.tenant, {
    slug:     input.slug,
    title:    input.title,
    content:  input.content,
    date:     input.date,
    imageUrl: input.imageUrl,
  })

  return {
    newItemId:        draft.itemId,
    confirmationHash: draft.preview.confirmationHash,
  }
}
