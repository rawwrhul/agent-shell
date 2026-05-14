#!/usr/bin/env bash
# phase4-scaffold.sh
#
# Replaces the fictional Framer integration with verified-against-real-API code.
#
# Backs up originals to .fictional.bak so you can git diff and recover if needed.
# Rewrites:
#   - src/integrations/framer/client.ts    (real method calls from Phase 0-3)
#   - src/integrations/framer/executor.ts  (two real executors)
#   - src/integrations/framer/tools.ts     (real read tools + draft tool)
#   - src/execution/dispatcher.ts          (updated registry)
#
# After running, this script does NOT delete the .fictional.bak files.
# Verify with `git diff`, then `rm src/integrations/framer/*.fictional.bak`
# and `rm src/execution/dispatcher.ts.fictional.bak`.
#
# Run from the agent-shell-v3 project root.

set -euo pipefail

# --- Backup originals ---------------------------------------------------------
echo "[backup] saving originals as .fictional.bak..."
for f in \
  src/integrations/framer/client.ts \
  src/integrations/framer/executor.ts \
  src/integrations/framer/tools.ts \
  src/execution/dispatcher.ts; do
  if [ -f "$f" ]; then
    cp "$f" "$f.fictional.bak"
    echo "  - $f → $f.fictional.bak"
  fi
done
echo ""

# --- src/integrations/framer/client.ts ----------------------------------------
cat > src/integrations/framer/client.ts << 'TS_EOF'
// src/integrations/framer/client.ts
//
// Thin wrapper around the `framer-api` npm package.
//
// Auth model:
//   - API key per project, stored encrypted in integration_credentials.
//   - Project URL stored in tenants.framer_project_url (non-secret).
//
// Method surface in this file matches what was verified in
// scripts/framer-manual-tests/ (Phase 0–3, see docs/framer-capabilities.md).
// If a method here doesn't appear in framer-api's .d.ts, it's a bug — verify
// before adding.
//
// Architectural notes:
//   - `framer-api` is ESM with top-level await. Our build is CJS. We hide the
//     dynamic import inside `new Function` so TS doesn't downlevel it (would
//     throw ERR_REQUIRE_ASYNC_MODULE).
//   - `connect(url, token)` returns a remote-API instance with
//     `framer.mode === "api"`. Methods are attached to the instance, not its
//     prototype.

import { loadCredential } from '../storage'
import type { TenantConfig } from '../../tenants/types'
import { logger } from '../../logger'

// The framer-api package's runtime instance has dynamically-attached methods;
// the .d.ts surface is rich but we type loosely here and trust the wrapper.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FramerClient = any

const BLOG_COLLECTION_NAME = 'Blog'

let _connectFn: ((projectUrl: string, apiKey: string) => Promise<FramerClient>) | null = null

async function getConnect(): Promise<(projectUrl: string, apiKey: string) => Promise<FramerClient>> {
  if (_connectFn) return _connectFn
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>
  const mod = await dynamicImport('framer-api') as { connect?: (url: string, key: string) => Promise<FramerClient> }
  _connectFn = mod.connect ?? null
  if (!_connectFn) throw new Error('framer-api: connect not found on module')
  return _connectFn
}

export interface FramerSession {
  client:     FramerClient
  disconnect: () => Promise<void>
}

export async function openFramerSession(tenant: TenantConfig): Promise<FramerSession> {
  const projectUrl = tenant.framer_project_url
  if (!projectUrl) {
    throw new Error(`Tenant ${tenant.tenantId}: framer_project_url not set in tenants table`)
  }

  const cred = await loadCredential(tenant.tenantId, 'framer')
  if (!cred) {
    throw new Error(`Tenant ${tenant.tenantId}: no Framer API key stored. Run set-credential script.`)
  }

  const connect = await getConnect()
  const client = await connect(projectUrl, cred.secret)
  logger.info('framer_session_open', { tenantId: tenant.tenantId, projectUrl })

  return {
    client,
    disconnect: async () => {
      try { await client.disconnect() } catch (err) {
        logger.warn('framer_disconnect_error', { tenantId: tenant.tenantId, err: String(err).slice(0, 200) })
      }
    },
  }
}

export async function withFramerSession<T>(
  tenant: TenantConfig,
  fn:     (client: FramerClient) => Promise<T>,
): Promise<T> {
  const session = await openFramerSession(tenant)
  try {
    return await fn(session.client)
  } finally {
    await session.disconnect()
  }
}

// ── Project / publish info reads ────────────────────────────────────────────

export interface ProjectInfo {
  id:           string
  name:         string
  apiVersion1Id?: string
}

export async function getProjectInfo(tenant: TenantConfig): Promise<ProjectInfo> {
  return withFramerSession(tenant, async (fr) => fr.getProjectInfo()) as Promise<ProjectInfo>
}

export interface PublishInfo {
  staging:    { deploymentTime: number;  optimizationStatus: string;  url: string;  currentPageUrl: string }
  production: { deploymentTime: number;  optimizationStatus: string;  url: string;  currentPageUrl: string }
}

export async function getPublishInfo(tenant: TenantConfig): Promise<PublishInfo> {
  return withFramerSession(tenant, async (fr) => fr.getPublishInfo()) as Promise<PublishInfo>
}

export interface ChangedPaths {
  added:    string[]
  removed:  string[]
  modified: string[]
}

export async function getChangedPaths(tenant: TenantConfig): Promise<ChangedPaths> {
  return withFramerSession(tenant, async (fr) => fr.getChangedPaths()) as Promise<ChangedPaths>
}

export async function getPendingChangesCount(tenant: TenantConfig): Promise<number> {
  const c = await getChangedPaths(tenant)
  return (c.added?.length ?? 0) + (c.removed?.length ?? 0) + (c.modified?.length ?? 0)
}

// ── Collection reads ────────────────────────────────────────────────────────

export interface CollectionSummary {
  id:        string
  name:      string
  managedBy: 'user' | 'thisPlugin' | 'anotherPlugin' | string
}

export async function listCollections(tenant: TenantConfig): Promise<CollectionSummary[]> {
  return withFramerSession(tenant, async (fr) => {
    const cs = await fr.getCollections()
    return cs.map((c: { id: string; name: string; managedBy?: string }) => ({
      id: c.id, name: c.name, managedBy: c.managedBy ?? 'unknown',
    }))
  })
}

async function findBlog(fr: FramerClient): Promise<FramerClient> {
  const collections = await fr.getCollections()
  const blog = collections.find((c: { name: string }) => c.name === BLOG_COLLECTION_NAME)
  if (!blog) {
    throw new Error(`No collection named "${BLOG_COLLECTION_NAME}" in this Framer project.`)
  }
  return blog
}

export interface BlogFieldIds {
  titleId:   string
  dateId:    string
  contentId: string
}

async function resolveBlogFieldIds(blog: FramerClient): Promise<BlogFieldIds> {
  const fields = await blog.getFields()
  const byName: Record<string, { id: string }> = {}
  for (const f of fields) byName[f.name] = f
  const titleId   = byName['Title']?.id
  const dateId    = byName['Date']?.id
  const contentId = byName['Content']?.id
  if (!titleId || !dateId || !contentId) {
    throw new Error(`Blog schema missing required field. Have: ${Object.keys(byName).join(', ')}`)
  }
  return { titleId, dateId, contentId }
}

export interface BlogItemSummary {
  id:    string
  slug:  string
  title: string
  date?: string
}

export async function listBlogItems(tenant: TenantConfig): Promise<BlogItemSummary[]> {
  return withFramerSession(tenant, async (fr) => {
    const blog = await findBlog(fr)
    const { titleId, dateId } = await resolveBlogFieldIds(blog)
    const items = await blog.getItems()
    return items.map((i: { id: string; slug: string; fieldData: Record<string, { value: unknown }> }) => ({
      id:    i.id,
      slug:  i.slug,
      title: String(i.fieldData[titleId]?.value ?? ''),
      date:  String(i.fieldData[dateId]?.value ?? ''),
    }))
  })
}

// ── Draft + preview (write to data model, NOT to production) ────────────────

export interface BlogPostDraft {
  slug:    string
  title:   string
  content: string             // HTML in Framer's formattedText format
  date?:   string             // ISO 8601; defaults to now
}

export interface FramerPreviewChange {
  type:   string
  nodeId: string
  name:   string
  status: 'added' | 'modified' | 'removed' | string
}

export interface FramerPreviewResult {
  action:            'preview'
  status:            string
  message:           string
  stagingEnabled:    boolean
  confirmationHash:  string
  errors:            unknown[]
  warnings:          unknown[]
  changes:           FramerPreviewChange[]
  changesCount:      number
  urls:              { production: string }
  nextAction:        { type: string; confirmationHash: string }
}

export interface DraftAndPreviewResult {
  itemId:  string
  post:    BlogPostDraft
  preview: FramerPreviewResult
}

/**
 * Creates the CMS item AND runs the publish preview. Refuses to proceed if
 * pending changes already exist in the workspace (we don't want to commit
 * unrelated edits along with the agent's post).
 *
 * On preview failure, rolls back the created item.
 */
export async function draftAndPreviewBlogPost(
  tenant: TenantConfig,
  post:   BlogPostDraft,
): Promise<DraftAndPreviewResult> {
  return withFramerSession(tenant, async (fr) => {
    // Preflight: no other pending changes
    const cp = await fr.getChangedPaths()
    const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
    if (pending > 0) {
      throw new Error(
        `Refusing to draft: ${pending} pending change(s) already in workspace. Clear them in Framer's UI first.`
      )
    }

    const blog = await findBlog(fr)
    const { titleId, dateId, contentId } = await resolveBlogFieldIds(blog)

    await blog.addItems([{
      slug: post.slug,
      fieldData: {
        [titleId]:   { type: 'string',        value: post.title },
        [dateId]:    { type: 'date',          value: post.date ?? new Date().toISOString() },
        [contentId]: { type: 'formattedText', value: post.content },
      },
    }])

    const items = await blog.getItems()
    const created = items.find((i: { slug: string }) => i.slug === post.slug)
    if (!created) {
      throw new Error(`addItems succeeded but slug "${post.slug}" not found on read-back.`)
    }
    const itemId = created.id

    let preview: FramerPreviewResult
    try {
      preview = await fr.publishForAgent({ action: 'preview' }) as FramerPreviewResult
    } catch (err) {
      // Roll back the just-created item so we don't leave an orphaned draft
      try { await blog.removeItems([itemId]) } catch (rbErr) {
        throw new Error(
          `previewPublish failed AND rollback also failed.\n` +
          `Original: ${String(err).slice(0, 200)}\nRollback: ${String(rbErr).slice(0, 200)}`
        )
      }
      throw err
    }

    return { itemId, post, preview }
  })
}

/**
 * Commit a previously-previewed change set. Production write. Gate every call
 * through the approval flow.
 */
export interface ConfirmPublishResult {
  action:      'confirm_publish'
  status:      string
  deployment?: { id: string }
  hostnames?:  Array<{ hostname: string;  type?: string;  isPrimary?: boolean;  isPublished?: boolean;  deploymentId?: string }>
  [key:        string]: unknown
}

export async function confirmPublish(
  tenant:           TenantConfig,
  confirmationHash: string,
): Promise<ConfirmPublishResult> {
  if (!confirmationHash) throw new Error('confirmPublish requires a confirmationHash')
  return withFramerSession(tenant, async (fr) =>
    fr.publishForAgent({ action: 'confirm_publish', confirmationHash })
  ) as Promise<ConfirmPublishResult>
}

/**
 * Remove a CMS item. Used for rollback on rejection.
 */
export async function removeBlogPost(tenant: TenantConfig, itemId: string): Promise<void> {
  return withFramerSession(tenant, async (fr) => {
    const blog = await findBlog(fr)
    await blog.removeItems([itemId])
  })
}
TS_EOF
echo "[write] src/integrations/framer/client.ts"

# --- src/integrations/framer/executor.ts --------------------------------------
cat > src/integrations/framer/executor.ts << 'TS_EOF'
// src/integrations/framer/executor.ts
//
// Handlers for approved Framer actions. The execution worker dispatches here
// via src/execution/dispatcher.ts.
//
// Two executors:
//   - execFramerConfirmPublish — commits a preview using its confirmationHash
//   - execFramerRollbackDraft  — removes a draft CMS item (cleanup)
//
// The "draft + preview" step is NOT an executor — it's a tool the agent
// invokes directly (see tools.ts: framer_draft_blog_post). The agent calls
// it during reasoning, gets back {itemId, confirmationHash, ...}, and then
// files a propose_action with toolName='framer_confirm_publish' and toolInput
// containing the hash + itemId (for display + potential rollback).
//
// Each handler:
//   - Loads tenant + credential via the client wrapper
//   - Performs the operation
//   - Returns an ExecutionResult (never throws — errors become ok:false)

import * as fr from './client'
import { logger } from '../../logger'
import type { IntegrationContext, ExecutionResult } from '../types'

// ── framer_confirm_publish ─────────────────────────────────────────────────

export interface ConfirmPublishInput {
  confirmationHash: string
  itemId?:          string   // for display + rollback if confirm fails
  slug?:            string   // for human-readable summary
  title?:           string   // for human-readable summary
}

export async function execFramerConfirmPublish(
  input: ConfirmPublishInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.confirmationHash) {
      return { ok: false, summary: 'confirmationHash is required', error: 'missing confirmationHash' }
    }

    const result = await fr.confirmPublish(ctx.tenant, input.confirmationHash)
    logger.info('exec_framer_confirm_publish', {
      tenantId:     ctx.tenant.tenantId,
      taskId:       ctx.taskId,
      approvalId:   ctx.approvalId,
      deploymentId: result.deployment?.id,
      slug:         input.slug,
    })

    const productionHost = result.hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname
    const summary = input.title
      ? `Published "${input.title}" to ${productionHost ?? 'production'}`
      : `Published deployment ${result.deployment?.id ?? '(unknown)'} to ${productionHost ?? 'production'}`

    return {
      ok:      true,
      summary,
      detail:  {
        ...input,
        result,
        productionUrl: productionHost ? `https://${productionHost}/${input.slug ?? ''}` : undefined,
      },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer confirm_publish failed', error: String(err).slice(0, 500) }
  }
}

// ── framer_rollback_draft ──────────────────────────────────────────────────

export interface RollbackDraftInput {
  itemId: string
  slug?:  string   // for the summary line
}

export async function execFramerRollbackDraft(
  input: RollbackDraftInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.itemId) {
      return { ok: false, summary: 'itemId is required', error: 'missing itemId' }
    }

    await fr.removeBlogPost(ctx.tenant, input.itemId)
    logger.info('exec_framer_rollback_draft', {
      tenantId:   ctx.tenant.tenantId,
      taskId:     ctx.taskId,
      approvalId: ctx.approvalId,
      itemId:     input.itemId,
      slug:       input.slug,
    })

    return {
      ok:      true,
      summary: input.slug
        ? `Removed draft "${input.slug}" from Blog`
        : `Removed draft item ${input.itemId} from Blog`,
      detail:  { ...input, rolledBack: true },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer rollback failed', error: String(err).slice(0, 500) }
  }
}
TS_EOF
echo "[write] src/integrations/framer/executor.ts"

# --- src/integrations/framer/tools.ts -----------------------------------------
cat > src/integrations/framer/tools.ts << 'TS_EOF'
// src/integrations/framer/tools.ts
//
// Anthropic tool definitions for Framer (agent-callable surface).
//
// Read tools — agent calls these freely:
//   - framer_get_project_info
//   - framer_get_publish_info
//   - framer_get_changed_paths
//   - framer_list_blog_items
//
// Write-but-staged tool — agent calls this directly (not via propose_action):
//   - framer_draft_blog_post  Creates the CMS item AND runs preview. Result
//                             goes back to the agent, which then files a
//                             propose_action with toolName='framer_confirm_publish'
//                             and the resulting confirmationHash.
//
// Approval-gated executors live in executor.ts (NOT in this tool list):
//   - framer_confirm_publish  Commits the previewed change to production.
//   - framer_rollback_draft   Removes a stale draft.

import type Anthropic from '@anthropic-ai/sdk'
import type { TenantConfig } from '../../tenants/types'
import * as fr from './client'

export const FRAMER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'framer_get_project_info',
    description:
      'Get high-level info about the Framer project (id, name, API version). ' +
      'Useful for orientation before drafting any change.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_get_publish_info',
    description:
      'Get the current staging and production URLs and their most recent deployment times. ' +
      'Use this to confirm what the live site is and when it was last updated.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_get_changed_paths',
    description:
      'List unpublished changes in the Framer workspace (added/modified/removed). ' +
      'IMPORTANT: framer_draft_blog_post will refuse to run if this returns any pending changes, ' +
      'because publishing would bundle them together with the agent\'s post. ' +
      'Call this first; if non-empty, surface the situation to the operator instead of drafting.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_list_blog_items',
    description:
      'List existing blog posts in the Blog collection (id, slug, title, date). ' +
      'Use this BEFORE drafting a new post to: (1) avoid creating a duplicate slug, ' +
      '(2) learn the existing post style and topic mix, (3) confirm the Blog collection ' +
      'is reachable. Returns all items.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'framer_draft_blog_post',
    description:
      'Create a new blog post in Tarino\'s Blog collection AND run a publish preview in one step. ' +
      'The post is created in the data model but NOT yet published to production — that requires ' +
      'a separate approval (see workflow below). ' +
      '\n\n' +
      'Returns: { itemId, confirmationHash, changes, warnings, errors, urls, next_step }. ' +
      '\n\n' +
      'REQUIRED WORKFLOW after calling this tool: ' +
      'immediately file propose_action with toolName="framer_confirm_publish" and toolInput=' +
      '{ confirmationHash, itemId, slug, title }. The approval card will show the operator the ' +
      'changelog from this preview. On approval, the post ships to tarino.au. ' +
      '\n\n' +
      'If you do not file propose_action, the post stays as an unpublished draft in Framer ' +
      'and never goes live. That\'s safe but messy — file the approval. ' +
      '\n\n' +
      'Refuses to run if there are existing unpublished changes in the workspace (check ' +
      'framer_get_changed_paths first).',
    input_schema: {
      type: 'object' as const,
      properties: {
        slug:    { type: 'string', description: 'URL-safe identifier, e.g. "offshore-hiring-2026". Must be unique among existing blog posts.' },
        title:   { type: 'string', description: 'Plain-text post title shown in the blog list and browser tab.' },
        content: { type: 'string', description: 'HTML body in Framer formattedText format. Use <p dir="auto">, <h2>, <strong>, <ul>, <li>, etc.' },
        date:    { type: 'string', description: 'Optional ISO 8601 publish date. Defaults to now if omitted.' },
      },
      required: ['slug', 'title', 'content'],
    },
  },
]

const FRAMER_TOOL_NAMES = new Set(FRAMER_TOOLS.map(t => t.name))

export function isFramerToolName(name: string): boolean {
  return FRAMER_TOOL_NAMES.has(name)
}

export async function executeFramerTool(
  name:   string,
  input:  Record<string, unknown>,
  tenant: TenantConfig,
): Promise<string> {
  try {
    switch (name) {
      case 'framer_get_project_info': {
        const info = await fr.getProjectInfo(tenant)
        return JSON.stringify(info, null, 2)
      }
      case 'framer_get_publish_info': {
        const info = await fr.getPublishInfo(tenant)
        return JSON.stringify(info, null, 2)
      }
      case 'framer_get_changed_paths': {
        const changes = await fr.getChangedPaths(tenant)
        const total = (changes.added?.length ?? 0) + (changes.removed?.length ?? 0) + (changes.modified?.length ?? 0)
        return JSON.stringify({ ...changes, total }, null, 2)
      }
      case 'framer_list_blog_items': {
        const items = await fr.listBlogItems(tenant)
        return JSON.stringify({ count: items.length, items }, null, 2)
      }
      case 'framer_draft_blog_post': {
        const i = input as { slug: string; title: string; content: string; date?: string }
        if (!i.slug || !i.title || !i.content) {
          return 'framer_draft_blog_post error: slug, title, and content are required'
        }
        const result = await fr.draftAndPreviewBlogPost(tenant, {
          slug: i.slug, title: i.title, content: i.content, date: i.date,
        })
        return JSON.stringify({
          itemId:           result.itemId,
          confirmationHash: result.preview.confirmationHash,
          changes:          result.preview.changes,
          changesCount:     result.preview.changesCount,
          warnings:         result.preview.warnings,
          errors:           result.preview.errors,
          urls:             result.preview.urls,
          next_step:        `Now call propose_action with toolName="framer_confirm_publish" and toolInput={"confirmationHash":"${result.preview.confirmationHash}","itemId":"${result.itemId}","slug":"${i.slug}","title":${JSON.stringify(i.title)}}`,
        }, null, 2)
      }
      default:
        return `Unknown Framer tool: ${name}`
    }
  } catch (err) {
    return `Framer tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
TS_EOF
echo "[write] src/integrations/framer/tools.ts"

# --- src/execution/dispatcher.ts ----------------------------------------------
cat > src/execution/dispatcher.ts << 'TS_EOF'
// src/execution/dispatcher.ts
//
// Routes an approved action's tool_name to the correct integration handler.

import type { IntegrationContext, ExecutionResult } from '../integrations/types'
import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
} from '../integrations/framer/executor'
import { execGscSubmitSitemap } from '../integrations/gsc/executor'

// Map of tool_name → handler.
// When the agent proposes an action via `propose_action`, the toolName field on
// the approval determines which handler executes. Handler signature is uniform:
// (input, ctx) → ExecutionResult.
const HANDLERS: Record<
  string,
  (input: Record<string, unknown>, ctx: IntegrationContext) => Promise<ExecutionResult>
> = {
  // Framer — two-phase commit:
  //   1) Agent calls framer_draft_blog_post (a tool, not an executor) which
  //      creates the CMS item and returns a confirmationHash.
  //   2) Agent files propose_action with toolName='framer_confirm_publish'.
  //   3) Operator approves → this executor commits to production.
  //   4) Rejection / cleanup → framer_rollback_draft removes the draft item.
  'framer_confirm_publish':    (i, c) => execFramerConfirmPublish(i as unknown as Parameters<typeof execFramerConfirmPublish>[0], c),
  'framer_rollback_draft':     (i, c) => execFramerRollbackDraft(i as unknown as Parameters<typeof execFramerRollbackDraft>[0], c),

  // GSC
  'gsc_submit_sitemap':        (i, c) => execGscSubmitSitemap(i as unknown as Parameters<typeof execGscSubmitSitemap>[0], c),
}

export async function dispatchExecution(
  toolName: string,
  input:    Record<string, unknown>,
  ctx:      IntegrationContext,
): Promise<ExecutionResult> {
  const handler = HANDLERS[toolName]
  if (!handler) {
    return {
      ok: false,
      summary: `No execution handler registered for tool "${toolName}"`,
      error:   `unknown tool_name: ${toolName}`,
    }
  }
  return handler(input, ctx)
}

export function isExecutableToolName(toolName: string): boolean {
  return toolName in HANDLERS
}
TS_EOF
echo "[write] src/execution/dispatcher.ts"

echo ""
echo "✓ Phase 4 replacement complete."
echo ""
echo "What changed:"
echo "  - client.ts:      replaced 'if (typeof fr.X === function) return fr.X(...)' chains"
echo "                    with real method calls matching framer-api 0.1.9"
echo "  - executor.ts:    dropped 5 fictional executors, added 2 real ones:"
echo "                      execFramerConfirmPublish, execFramerRollbackDraft"
echo "  - tools.ts:       dropped 4 fictional read tools + 2 fictional draft tools."
echo "                    Added: framer_get_publish_info, framer_list_blog_items,"
echo "                    framer_draft_blog_post (the agent-callable write)."
echo "  - dispatcher.ts:  registers the 2 real Framer executors."
echo ""
echo "Originals backed up as *.fictional.bak. Run 'git diff' to review changes."
echo ""
echo "Next steps:"
echo "  1. git diff src/integrations/framer/ src/execution/dispatcher.ts"
echo "  2. Run your typecheck (tsc) — verify no broken imports anywhere else"
echo "     in the codebase that referenced the dropped executor names"
echo "     (execFramerUpdatePageSeo, execFramerPublishPreview, etc.)"
echo "     Particularly check src/skills/seo/SKILL.md — it likely teaches the"
echo "     agent to use the OLD tool names."
echo "  3. Once happy: rm src/integrations/framer/*.fictional.bak src/execution/dispatcher.ts.fictional.bak"
echo "  4. Phase 5 (SKILL.md update + Slack smoke test) is the next unit."
