#!/usr/bin/env python3
"""
phase9e-patch.py — Phase 9e: preflight orphan-prevention before deploy.

Tonight we cleaned up an orphan blog post (offshore-hiring-mistakes-australia)
that got swept to production when the user manually published a different
intentional draft. Root cause: Framer's deploy is workspace-wide, not
item-specific. Anything sitting in staging-ahead-of-prod gets flushed live
together with whatever we're trying to deploy.

The fix: before we call confirmPublish (which commits our draft to staging),
we check whether staging is already ahead of production. If it is, there are
pre-existing changes that aren't ours — refuse to deploy and surface a clean
error so the operator can investigate.

Mechanic: Framer's `getPublishInfo()` returns timestamps for both staging
and production. If `staging.deploymentTime > production.deploymentTime`,
staging is dirty. We don't have a per-item diff API, but the timestamp
check is sufficient — a clean prod has staging == production.

  1. EDIT src/integrations/framer/executor.ts — insert preflight check at
     the top of execFramerConfirmPublish, before the confirmPublish call.

Run from project root. Idempotent — detects if Phase 9e is already applied
and exits cleanly.
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
        sys.exit(f'fatal: anchor not found in {where}:\n---\n{anchor[:400]}\n---')
    if text.count(anchor) > 1:
        sys.exit(f'fatal: anchor matched MORE THAN ONCE in {where}; tighten it')
    return text.replace(anchor, new)

# ── EDIT: src/integrations/framer/executor.ts ─────────────────────────────
P = ROOT / 'src/integrations/framer/executor.ts'
src = must_read(P)

if 'Phase 9e' in src or 'STAGING_AHEAD_OF_PRODUCTION' in src:
    print('[1/1] executor.ts already has Phase 9e preflight — skipping')
else:
    old_block = (
        "  try {\n"
        "    if (!input.confirmationHash) {\n"
        "      return { ok: false, summary: 'confirmationHash is required', error: 'missing confirmationHash' }\n"
        "    }\n"
        "\n"
        "    // Step 1: commit the draft to staging via confirm_publish.\n"
        "    const stagingResult = await fr.confirmPublish(ctx.tenant, input.confirmationHash)"
    )
    new_block = (
        "  try {\n"
        "    if (!input.confirmationHash) {\n"
        "      return { ok: false, summary: 'confirmationHash is required', error: 'missing confirmationHash' }\n"
        "    }\n"
        "\n"
        "    // Phase 9e: preflight orphan-prevention check.\n"
        "    // Framer's deploy is workspace-wide — anything sitting in staging-ahead-of-\n"
        "    // production gets flushed live together with our draft. Before we commit our\n"
        "    // draft to staging, verify staging matches production. If staging is already\n"
        "    // ahead, refuse and surface to the operator.\n"
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
        "    const stagingResult = await fr.confirmPublish(ctx.tenant, input.confirmationHash)"
    )
    src = replace_one(src, old_block, new_block, 'executor.ts execFramerConfirmPublish preflight')
    P.write_text(src)
    print('[1/1] executor.ts — Phase 9e preflight orphan-prevention installed')

print('\nDone. Run:')
print('  npx tsc --noEmit')
print('to verify, then commit + push.')
