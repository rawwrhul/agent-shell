#!/usr/bin/env python3
"""
phase9de-patch.py — Combined Phase 9d + 9e.

Diagnostic confirmed: Phase 9d never actually committed (last commit is the
Phase 9c circular-import fix, and `deployToProduction` is absent from
client.ts). This means:

  * The executor only commits drafts to staging via confirmPublish.
  * The live production domain only gets the update when a human clicks
    Publish in Framer's UI (which is what happened last night, and what
    swept the orphan post live alongside the intentional one).

This patch ships BOTH fixes in one go:

  PHASE 9d — adds deployToProduction() to client.ts and chains it after
    confirmPublish in executor.ts. confirmPublish stages, deployToProduction
    pushes to the live custom domain (e.g. tarino.au).

  PHASE 9e — adds a preflight check BEFORE confirmPublish that verifies
    staging is in sync with production. If staging is already ahead of prod,
    refuses with STAGING_AHEAD_OF_PRODUCTION and tells the operator what
    to do. Prevents the orphan-sweep scenario from happening again.

  1. EDIT src/integrations/framer/client.ts — appends deployToProduction
     interface + function after confirmPublish.

  2. EDIT src/integrations/framer/executor.ts — replaces the body of
     execFramerConfirmPublish with the Phase 9e preflight + Phase 9d
     deploy chain.

Run from project root. Idempotent — checks markers before applying each
section.
"""
from __future__ import annotations
import sys
from pathlib import Path

ROOT = Path.cwd()
assert (ROOT / 'package.json').exists() and (ROOT / 'src').exists(), 'Run from project root.'

def must_read(p):
    if not p.exists(): sys.exit(f'fatal: file missing: {p}')
    return p.read_text()

def replace_one(text, anchor, new, where):
    if anchor not in text:
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:600]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── 1. EDIT: src/integrations/framer/client.ts — add deployToProduction ───
P = ROOT / 'src/integrations/framer/client.ts'
src = must_read(P)

if 'deployToProduction' in src:
    print('[1/2] client.ts already has deployToProduction — skipping')
else:
    anchor = (
        "export async function confirmPublish(\n"
        "  tenant:           TenantConfig,\n"
        "  confirmationHash: string,\n"
        "): Promise<ConfirmPublishResult> {\n"
        "  if (!confirmationHash) throw new Error('confirmPublish requires a confirmationHash')\n"
        "  return withFramerSession(tenant, async (fr) =>\n"
        "    fr.publishForAgent({ action: 'confirm_publish', confirmationHash })\n"
        "  ) as Promise<ConfirmPublishResult>\n"
        "}"
    )
    replacement = anchor + (
        "\n\n"
        "// ── Phase 9d: deploy_to_production ──────────────────────────────────────────\n"
        "// confirmPublish only stages the change; the live custom domain stays untouched\n"
        "// until publishForAgent({ action: 'deploy_to_production' }) fires. This mirrors\n"
        "// the two-step behaviour documented in scripts/framer-manual-tests/05-publish.mts.\n"
        "export interface DeployToProductionResult {\n"
        "  action:      'deploy_to_production'\n"
        "  status:      string\n"
        "  deployment?: { id: string }\n"
        "  hostnames?:  Array<{ hostname: string;  type?: string;  isPrimary?: boolean;  isPublished?: boolean;  deploymentId?: string }>\n"
        "  [key:        string]: unknown\n"
        "}\n"
        "\n"
        "export async function deployToProduction(\n"
        "  tenant: TenantConfig,\n"
        "): Promise<DeployToProductionResult> {\n"
        "  return withFramerSession(tenant, async (fr) =>\n"
        "    fr.publishForAgent({ action: 'deploy_to_production' })\n"
        "  ) as Promise<DeployToProductionResult>\n"
        "}"
    )
    src = replace_one(src, anchor, replacement, 'client.ts confirmPublish → deployToProduction append')
    P.write_text(src)
    print('[1/2] client.ts — deployToProduction function added')

# ── 2. EDIT: src/integrations/framer/executor.ts — Phase 9e preflight + 9d chain
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)

if 'Phase 9d' in src or 'Phase 9e' in src or 'deployToProduction' in src:
    print('[2/2] executor.ts already has Phase 9d/9e markers — skipping')
else:
    # Replace the entire body of execFramerConfirmPublish (from the line right
    # after the confirmationHash guard, through the function's closing brace).
    anchor = (
        "    if (!input.confirmationHash) {\n"
        "      return { ok: false, summary: 'confirmationHash is required', error: 'missing confirmationHash' }\n"
        "    }\n"
        "\n"
        "    const result = await fr.confirmPublish(ctx.tenant, input.confirmationHash)\n"
        "    logger.info('exec_framer_confirm_publish', {\n"
        "      tenantId:     ctx.tenant.tenantId,\n"
        "      taskId:       ctx.taskId,\n"
        "      approvalId:   ctx.approvalId,\n"
        "      deploymentId: result.deployment?.id,\n"
        "      slug:         input.slug,\n"
        "    })\n"
        "\n"
        "    const productionHost = result.hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname\n"
        "    const summary = input.title\n"
        "      ? `Published \"${input.title}\" to ${productionHost ?? 'production'}`\n"
        "      : `Published deployment ${result.deployment?.id ?? '(unknown)'} to ${productionHost ?? 'production'}`\n"
        "\n"
        "    return {\n"
        "      ok:      true,\n"
        "      summary,\n"
        "      detail:  {\n"
        "        ...input,\n"
        "        result,\n"
        "        productionUrl: productionHost ? `https://${productionHost}/${input.slug ?? ''}` : undefined,\n"
        "      },\n"
        "    }\n"
        "  } catch (err) {\n"
        "    return { ok: false, summary: 'Framer confirm_publish failed', error: String(err).slice(0, 500) }\n"
        "  }"
    )
    replacement = (
        "    if (!input.confirmationHash) {\n"
        "      return { ok: false, summary: 'confirmationHash is required', error: 'missing confirmationHash' }\n"
        "    }\n"
        "\n"
        "    // Phase 9e: preflight orphan-prevention check.\n"
        "    // Framer's deploy is workspace-wide — anything sitting in staging-ahead-of-\n"
        "    // production gets flushed live alongside our draft. Before we commit our\n"
        "    // draft to staging, verify staging matches production. If staging is\n"
        "    // already ahead, refuse and surface a clean error to the operator.\n"
        "    try {\n"
        "      const pubInfo = await fr.getPublishInfo(ctx.tenant)\n"
        "      const stagingTime = pubInfo?.staging?.deploymentTime ?? 0\n"
        "      const productionTime = pubInfo?.production?.deploymentTime ?? 0\n"
        "      if (stagingTime > productionTime) {\n"
        "        const diffSec = Math.round((stagingTime - productionTime) / 1000)\n"
        "        logger.warn('preflight_staging_ahead_of_prod', {\n"
        "          tenantId:     ctx.tenant.tenantId,\n"
        "          taskId:       ctx.taskId,\n"
        "          approvalId:   ctx.approvalId,\n"
        "          slug:         input.slug,\n"
        "          stagingTime,\n"
        "          productionTime,\n"
        "          diffSeconds:  diffSec,\n"
        "        })\n"
        "        return {\n"
        "          ok:      false,\n"
        "          summary: `Staging has pending changes that pre-date this draft (staging is ${diffSec}s ahead of production). Refusing to deploy until staging matches production — otherwise the pending changes would publish too.`,\n"
        "          error:   'STAGING_AHEAD_OF_PRODUCTION',\n"
        "          detail: {\n"
        "            stagingDeploymentTime:    stagingTime,\n"
        "            productionDeploymentTime: productionTime,\n"
        "            diffSeconds:              diffSec,\n"
        "            action:                   'Open Framer → either publish the pending changes manually (if intended) or revert them (if not). Then retry this approval.',\n"
        "          },\n"
        "        }\n"
        "      }\n"
        "    } catch (err) {\n"
        "      // Preflight check failed at the API level (network, auth, etc).\n"
        "      // Don't block the deploy on infra issues — log and proceed. If staging\n"
        "      // really is dirty, the deploy still publishes orphans, but blocking on\n"
        "      // every transient API blip is worse than the alternative.\n"
        "      logger.warn('preflight_publish_info_failed', {\n"
        "        tenantId:   ctx.tenant.tenantId,\n"
        "        taskId:     ctx.taskId,\n"
        "        approvalId: ctx.approvalId,\n"
        "        err:        String(err).slice(0, 300),\n"
        "      })\n"
        "    }\n"
        "\n"
        "    // Step 1: commit the draft to staging via confirm_publish.\n"
        "    const stagingResult = await fr.confirmPublish(ctx.tenant, input.confirmationHash)\n"
        "    logger.info('exec_framer_confirm_publish', {\n"
        "      tenantId:     ctx.tenant.tenantId,\n"
        "      taskId:       ctx.taskId,\n"
        "      approvalId:   ctx.approvalId,\n"
        "      deploymentId: stagingResult.deployment?.id,\n"
        "      slug:         input.slug,\n"
        "    })\n"
        "\n"
        "    // Phase 9d: confirm_publish only deploys to staging. The production custom\n"
        "    // domain (e.g. tarino.au) stays untouched until deploy_to_production fires.\n"
        "    // Without this second call the page is 404 on prod even though the executor\n"
        "    // returned success. See client.ts deployToProduction + the framer manual\n"
        "    // test 05-publish.mts which documents this two-step behaviour.\n"
        "    let prodResult\n"
        "    try {\n"
        "      prodResult = await fr.deployToProduction(ctx.tenant)\n"
        "      logger.info('exec_framer_deploy_to_production', {\n"
        "        tenantId:     ctx.tenant.tenantId,\n"
        "        taskId:       ctx.taskId,\n"
        "        approvalId:   ctx.approvalId,\n"
        "        deploymentId: prodResult.deployment?.id,\n"
        "        slug:         input.slug,\n"
        "      })\n"
        "    } catch (err) {\n"
        "      // Staging was committed but production deploy failed. This is a\n"
        "      // partial-success state — the draft is live on <project>.framer.app\n"
        "      // but the operator needs to push to production manually (or we retry).\n"
        "      logger.error('exec_framer_deploy_to_production_failed', {\n"
        "        tenantId:            ctx.tenant.tenantId,\n"
        "        taskId:              ctx.taskId,\n"
        "        approvalId:          ctx.approvalId,\n"
        "        stagingDeploymentId: stagingResult.deployment?.id,\n"
        "        slug:                input.slug,\n"
        "        err:                 String(err).slice(0, 500),\n"
        "      })\n"
        "      return {\n"
        "        ok:      false,\n"
        "        summary: 'Committed to staging but deploy_to_production failed. Push manually from Framer UI or retry.',\n"
        "        error:   String(err).slice(0, 500),\n"
        "        detail:  { ...input, stagingResult },\n"
        "      }\n"
        "    }\n"
        "\n"
        "    // Use prodResult.hostnames for the production URL — it reflects the deploy\n"
        "    // that just happened. Fall back to stagingResult if prodResult is empty.\n"
        "    const hostnames = prodResult.hostnames ?? stagingResult.hostnames\n"
        "    const productionHost = hostnames?.find(h => h.type === 'custom' && h.isPublished)?.hostname\n"
        "    const summary = input.title\n"
        "      ? `Published \"${input.title}\" to ${productionHost ?? 'production'}`\n"
        "      : `Published deployment ${prodResult.deployment?.id ?? '(unknown)'} to ${productionHost ?? 'production'}`\n"
        "\n"
        "    return {\n"
        "      ok:      true,\n"
        "      summary,\n"
        "      detail:  {\n"
        "        ...input,\n"
        "        stagingResult,\n"
        "        prodResult,\n"
        "        productionUrl: productionHost ? `https://${productionHost}/${input.slug ?? ''}` : undefined,\n"
        "      },\n"
        "    }\n"
        "  } catch (err) {\n"
        "    return { ok: false, summary: 'Framer confirm_publish failed', error: String(err).slice(0, 500) }\n"
        "  }"
    )
    src = replace_one(src, anchor, replacement, 'executor.ts execFramerConfirmPublish body replacement')
    P.write_text(src)
    print('[2/2] executor.ts — Phase 9d deploy chain + Phase 9e preflight installed')

print('\nDone. Run:')
print('  npx tsc --noEmit && echo OK')
print('to verify, then commit + push.')
