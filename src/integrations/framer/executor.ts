// src/integrations/framer/executor.ts
//
// Handlers for approved Framer actions. The execution worker dispatches here.
//
// Each handler:
//   - Loads the per-tenant Framer credentials (handled by the client wrapper)
//   - Performs the operation
//   - Returns an ExecutionResult
//   - Never throws — errors get caught and surfaced as ok:false

import * as fr from './client'
import { logger } from '../../logger'
import type { IntegrationContext, ExecutionResult } from '../types'

interface UpdatePageSeoInput {
  pageId:        string
  title?:        string
  description?:  string
  ogTitle?:      string
  ogDescription?:string
  ogImage?:      string
  robots?:       string
  publish?:      boolean   // if true, immediately publish to preview after the update
  deploy?:       boolean   // if true AND publish === true, also deploy preview to production
}

export async function execFramerUpdatePageSeo(
  input: UpdatePageSeoInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    const { pageId, publish: shouldPublish, deploy: shouldDeploy, ...updateFields } = input
    if (!pageId) {
      return { ok: false, summary: 'pageId is required', error: 'missing pageId' }
    }

    const updateResult = await fr.updatePageSeo(ctx.tenant, pageId, updateFields)
    logger.info('exec_framer_update_seo', { tenantId: ctx.tenant.tenantId, pageId, taskId: ctx.taskId })

    const detail: Record<string, unknown> = { pageId, updated: updateFields, updateResult }

    if (shouldPublish) {
      const publishResult = await fr.publish(ctx.tenant)
      detail.preview = publishResult
      logger.info('exec_framer_publish', { tenantId: ctx.tenant.tenantId, deploymentId: publishResult.deployment.id, taskId: ctx.taskId })

      if (shouldDeploy) {
        const deployResult = await fr.deploy(ctx.tenant, publishResult.deployment.id)
        detail.deploy = deployResult
        logger.info('exec_framer_deploy', { tenantId: ctx.tenant.tenantId, deploymentId: publishResult.deployment.id, taskId: ctx.taskId })
      }
    }

    return {
      ok: true,
      summary: shouldDeploy
        ? `Updated SEO on ${pageId} and deployed to production`
        : shouldPublish
        ? `Updated SEO on ${pageId} and published preview`
        : `Updated SEO on ${pageId} (not yet published)`,
      detail,
    }
  } catch (err) {
    return { ok: false, summary: 'Framer SEO update failed', error: String(err).slice(0, 500) }
  }
}

interface PublishPreviewInput {
  // No inputs — operates on current unpublished state
}

export async function execFramerPublishPreview(
  _input: PublishPreviewInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    const result = await fr.publish(ctx.tenant)
    return {
      ok: true,
      summary: `Published preview (deployment ${result.deployment.id})`,
      detail: result as unknown as Record<string, unknown>,
    }
  } catch (err) {
    return { ok: false, summary: 'Framer publish failed', error: String(err).slice(0, 500) }
  }
}

interface DeployProductionInput {
  deploymentId: string
}

export async function execFramerDeployProduction(
  input: DeployProductionInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.deploymentId) {
      return { ok: false, summary: 'deploymentId is required', error: 'missing deploymentId' }
    }
    const result = await fr.deploy(ctx.tenant, input.deploymentId)
    return {
      ok: true,
      summary: `Deployed ${input.deploymentId} to production`,
      detail: { deploymentId: input.deploymentId, result },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer deploy failed', error: String(err).slice(0, 500) }
  }
}

interface UpdateCmsItemInput {
  collectionId: string
  itemId:       string
  fields:       Record<string, unknown>
}

export async function execFramerUpdateCmsItem(
  input: UpdateCmsItemInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.collectionId || !input.itemId) {
      return { ok: false, summary: 'collectionId and itemId required', error: 'missing required fields' }
    }
    const result = await fr.updateCmsItem(ctx.tenant, input.collectionId, input.itemId, input.fields ?? {})
    return {
      ok: true,
      summary: `Updated CMS item ${input.itemId} in ${input.collectionId}`,
      detail: { ...input, result },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer CMS update failed', error: String(err).slice(0, 500) }
  }
}

interface CreateCmsItemInput {
  collectionId: string
  fields:       Record<string, unknown>
}

export async function execFramerCreateCmsItem(
  input: CreateCmsItemInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.collectionId) {
      return { ok: false, summary: 'collectionId is required', error: 'missing collectionId' }
    }
    const result = await fr.createCmsItem(ctx.tenant, input.collectionId, { fields: input.fields ?? {} })
    return {
      ok: true,
      summary: `Created CMS item in ${input.collectionId}`,
      detail: { ...input, result },
    }
  } catch (err) {
    return { ok: false, summary: 'Framer CMS create failed', error: String(err).slice(0, 500) }
  }
}
