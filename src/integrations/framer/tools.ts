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
import { logger } from '../../logger'

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
        return JSON.stringify(info)
      }
      case 'framer_get_publish_info': {
        const info = await fr.getPublishInfo(tenant)
        return JSON.stringify(info)
      }
      case 'framer_get_changed_paths': {
        const changes = await fr.getChangedPaths(tenant)
        const total = (changes.added?.length ?? 0) + (changes.removed?.length ?? 0) + (changes.modified?.length ?? 0)
        return JSON.stringify({ ...changes, total })
      }
      case 'framer_list_blog_items': {
        const items = await fr.listBlogItems(tenant)
        return JSON.stringify({ count: items.length, items })
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
          confirmationHash: (() => {
            const h = result.preview?.confirmationHash ?? result.preview?.nextAction?.confirmationHash
            if (!h) {
              logger.error('framer_pitch_missing_hash', {
                tenantId: tenant.tenantId,
                itemId:   result.itemId,
                preview:  JSON.stringify(result.preview ?? null).slice(0, 1500),
              })
              throw new Error('Framer preview returned no confirmationHash on pitch draft')
            }
            return h
          })(),
          changes:          result.preview.changes,
          changesCount:     result.preview.changesCount,
          warnings:         result.preview.warnings,
          errors:           result.preview.errors,
          urls:             result.preview.urls,
          next_step:        `Now call propose_action with toolName="framer_confirm_publish" and toolInput={"confirmationHash":"${result.preview.confirmationHash}","itemId":"${result.itemId}","slug":"${i.slug}","title":${JSON.stringify(i.title)}}`,
        })
      }
      default:
        return `Unknown Framer tool: ${name}`
    }
  } catch (err) {
    return `Framer tool error (${name}): ${String(err).slice(0, 300)}`
  }
}
