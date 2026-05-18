#!/usr/bin/env node
// wire-p0-session4-marketing-text.js
//
// P0 Session 4: framer_update_marketing_page_text
//
// Surgical text update on non-CMS marketing pages (About/Contact/Resources/etc)
// via Canvas Nodes API (getNodesWithAttribute + getNodesWithType + setText).
// Single approval.
//
// Page creation deliberately deferred — agent has no design API to produce
// production-quality layouts, so URL-slot-creation alone is half-automation.
// Manual operator briefs are the right path for new pages.
//
// Idempotent. Safe to re-run.
//
// Run from repo root: node wire-p0-session4-marketing-text.js
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = process.cwd()
const FILES = {
  cmsWrite:   path.join(ROOT, 'src/integrations/framer/cms-write.ts'),
  executor:   path.join(ROOT, 'src/integrations/framer/executor.ts'),
  dispatcher: path.join(ROOT, 'src/execution/dispatcher.ts'),
}

function assertExists(p, why) {
  if (!fs.existsSync(p)) {
    console.error(`✗  missing: ${p} — ${why}`)
    process.exit(1)
  }
}
assertExists(FILES.cmsWrite,   'sessions 1-3 must be applied first')
assertExists(FILES.executor,   '')
assertExists(FILES.dispatcher, '')

const executorRaw = fs.readFileSync(FILES.executor, 'utf8')
if (!executorRaw.includes('execFramerAddInternalLink')) {
  console.error('✗  executor.ts missing execFramerAddInternalLink — session 3 not applied')
  process.exit(1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch executor.ts — append marketing-text executor
// ─────────────────────────────────────────────────────────────────────────────

let executorContent = executorRaw

if (executorContent.includes('execFramerUpdateMarketingPageText')) {
  console.log(`⚠  executor.ts already has execFramerUpdateMarketingPageText — skipping`)
} else {
  const EXECUTOR_BODY = `
// ── framer_update_marketing_page_text ───────────────────────────────────────
//
// Surgical text update on non-CMS marketing pages (About, Contact, Resources,
// homepage, etc). Uses Canvas Nodes API to find the target page by path,
// locate the TextNode whose current text exactly matches oldText, set the
// new text, then publish + deploy.
//
// Agent files propose_action with:
//   toolName:   'framer_update_marketing_page_text'
//   toolInput:  { pagePath, oldText, newText }
//   riskLevel:  'high'  (Tier A — substantive marketing-page change)
//
// Failure modes:
//   - PAGE_NOT_FOUND     pagePath doesn't match any page node
//   - TEXT_NOT_FOUND     oldText doesn't match any TextNode on the page
//   - AMBIGUOUS_TEXT     oldText matches >1 node — agent must be more specific
//   - CANVAS_API_UNAVAIL framer-api version doesn't expose getNodesWith*
//
// On any failure between setText and deploy: rollback to original text.
//
// Note: oldText must EXACTLY match the text in Framer's internal data model.
// HTML on the live site may differ slightly (entities, whitespace). When the
// match fails, the executor returns sample texts from the page so the agent
// can correct its oldText and retry.

export interface UpdateMarketingPageTextInput {
  pagePath: string
  oldText:  string
  newText:  string
}

export async function execFramerUpdateMarketingPageText(
  input: UpdateMarketingPageTextInput,
  ctx:   IntegrationContext,
): Promise<ExecutionResult> {
  try {
    if (!input.pagePath) return { ok: false, summary: 'pagePath is required', error: 'missing pagePath' }
    if (!input.oldText)  return { ok: false, summary: 'oldText is required',  error: 'missing oldText' }
    if (!input.newText)  return { ok: false, summary: 'newText is required',  error: 'missing newText' }
    if (input.oldText === input.newText) {
      return { ok: false, summary: 'oldText and newText are identical', error: 'NO_CHANGE' }
    }

    const result = await fr.withFramerSession(ctx.tenant, async (framer: any) => {
      const cp = await framer.getChangedPaths()
      const pending = (cp.added?.length ?? 0) + (cp.removed?.length ?? 0) + (cp.modified?.length ?? 0)
      if (pending > 0) {
        throw new Error(\`Refusing to edit: \${pending} pending change(s) already in Framer workspace.\`)
      }

      // Find the page node by path
      let pagesWithPath: any[]
      try {
        pagesWithPath = await framer.getNodesWithAttribute('path')
      } catch (err) {
        throw new Error(\`CANVAS_API_UNAVAIL: getNodesWithAttribute failed — framer-api version may not expose canvas APIs: \${String(err).slice(0, 200)}\`)
      }
      const pageNode = pagesWithPath.find((n: any) => n.path === input.pagePath)
      if (!pageNode) {
        const availablePaths = pagesWithPath
          .map((n: any) => n.path)
          .filter(Boolean)
          .slice(0, 15)
          .join(', ')
        throw new Error(\`PAGE_NOT_FOUND: no page with path "\${input.pagePath}". Available: \${availablePaths || '(none discovered)'}\`)
      }

      // Find text nodes within the page subtree
      let textNodes: any[]
      try {
        textNodes = await pageNode.getNodesWithType('TextNode')
      } catch (err) {
        throw new Error(\`CANVAS_API_UNAVAIL: pageNode.getNodesWithType failed: \${String(err).slice(0, 200)}\`)
      }

      // Find exact match for oldText
      const matches: any[] = []
      for (const node of textNodes) {
        let currentText: string
        try {
          currentText = await node.getText()
        } catch {
          continue
        }
        if (currentText === input.oldText) matches.push(node)
      }

      if (matches.length === 0) {
        const sampleTexts: string[] = []
        for (const n of textNodes.slice(0, 8)) {
          try {
            const t = await n.getText()
            if (t) sampleTexts.push(t.slice(0, 80))
          } catch { /* skip */ }
        }
        throw new Error(\`TEXT_NOT_FOUND: oldText not found on \${input.pagePath}. Sample texts on this page: \${sampleTexts.map(s => \`"\${s}"\`).join(' | ')}\`)
      }
      if (matches.length > 1) {
        throw new Error(\`AMBIGUOUS_TEXT: oldText "\${input.oldText.slice(0, 80)}" matches \${matches.length} text nodes on \${input.pagePath}. Make oldText more specific to disambiguate.\`)
      }

      const targetNode = matches[0]
      const beforeText = input.oldText

      try {
        await targetNode.setText(input.newText)
      } catch (err) {
        throw new Error(\`setText failed: \${String(err).slice(0, 200)}\`)
      }

      let prodResult: any
      try {
        const preview = await framer.publishForAgent({ action: 'preview' })
        const hash = preview?.confirmationHash ?? preview?.nextAction?.confirmationHash
        if (!hash) {
          throw new Error(\`Preview returned no confirmationHash. Shape: \${JSON.stringify(preview ?? null).slice(0, 500)}\`)
        }
        await framer.publishForAgent({ action: 'confirm_publish', confirmationHash: hash })
        prodResult = await framer.publishForAgent({ action: 'deploy_to_production' })
      } catch (err) {
        logger.warn('marketing_text_rollback_attempt', {
          tenantId: ctx.tenant.tenantId,
          pagePath: input.pagePath,
          err:      String(err).slice(0, 300),
        })
        try {
          await targetNode.setText(beforeText)
          logger.info('marketing_text_rolled_back', { tenantId: ctx.tenant.tenantId, pagePath: input.pagePath })
        } catch (rbErr) {
          logger.error('marketing_text_rollback_failed', {
            tenantId:    ctx.tenant.tenantId,
            pagePath:    input.pagePath,
            originalErr: String(err).slice(0, 300),
            rollbackErr: String(rbErr).slice(0, 300),
          })
        }
        throw err
      }

      return { beforeText, newText: input.newText, prodResult }
    })

    const projectHostname = (() => {
      try {
        const h = new URL(ctx.tenant.framer_project_url ?? '').hostname
        return h.startsWith('www.') ? h.slice(4) : h
      } catch {
        return undefined
      }
    })()
    const productionUrl = projectHostname ? \`https://\${projectHostname}\${input.pagePath}\` : input.pagePath

    logger.info('exec_framer_update_marketing_page_text', {
      tenantId:    ctx.tenant.tenantId,
      taskId:      ctx.taskId,
      approvalId:  ctx.approvalId,
      pagePath:    input.pagePath,
      oldTextLen:  input.oldText.length,
      newTextLen:  input.newText.length,
    })

    return {
      ok:      true,
      summary: \`Updated text on \${productionUrl}: "\${input.oldText.slice(0, 50)}" → "\${input.newText.slice(0, 50)}"\`,
      detail:  {
        pagePath:      input.pagePath,
        oldText:       input.oldText,
        newText:       input.newText,
        productionUrl,
        deploymentId:  result.prodResult.deployment?.id,
      },
    }
  } catch (err) {
    return {
      ok:      false,
      summary: \`framer_update_marketing_page_text failed: \${String(err).slice(0, 160)}\`,
      error:   String(err).slice(0, 500),
    }
  }
}
`

  executorContent = executorContent.trimEnd() + '\n' + EXECUTOR_BODY
  fs.writeFileSync(FILES.executor, executorContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.executor)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch dispatcher.ts — add import + map entry
// ─────────────────────────────────────────────────────────────────────────────

let dispatcherContent = fs.readFileSync(FILES.dispatcher, 'utf8')

if (dispatcherContent.includes('execFramerUpdateMarketingPageText')) {
  console.log(`⚠  dispatcher.ts already has execFramerUpdateMarketingPageText — skipping`)
} else {
  const OLD_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
  execFramerUpdateBlogBody,
  execFramerAddSiteSchema,
  execFramerAddBlogAltText,
  execFramerAddInternalLink,
} from '../integrations/framer/executor'`

  const NEW_IMPORT =
`import {
  execFramerConfirmPublish,
  execFramerRollbackDraft,
  execFramerCreateAndPublishBlogPost,
  execManualOperatorTask,
  execApproveBlogPitch,
  execFramerUpdateBlogMeta,
  execFramerUpdateBlogBody,
  execFramerAddSiteSchema,
  execFramerAddBlogAltText,
  execFramerAddInternalLink,
  execFramerUpdateMarketingPageText,
} from '../integrations/framer/executor'`

  if (!dispatcherContent.includes(OLD_IMPORT)) {
    console.error('✗  dispatcher.ts: import block does not match — session 3 not applied?')
    process.exit(1)
  }
  dispatcherContent = dispatcherContent.replace(OLD_IMPORT, NEW_IMPORT)

  const INTERNAL_LINK_ENTRY =
`  'framer_add_internal_link':  (i, c) =>
    execFramerAddInternalLink(i as unknown as Parameters<typeof execFramerAddInternalLink>[0], c),`

  if (!dispatcherContent.includes(INTERNAL_LINK_ENTRY)) {
    console.error('✗  dispatcher.ts: session 3 internal-link dispatcher entry not found')
    process.exit(1)
  }

  const NEW_ENTRY =
`  'framer_add_internal_link':  (i, c) =>
    execFramerAddInternalLink(i as unknown as Parameters<typeof execFramerAddInternalLink>[0], c),

  'framer_update_marketing_page_text': (i, c) =>
    execFramerUpdateMarketingPageText(i as unknown as Parameters<typeof execFramerUpdateMarketingPageText>[0], c),`

  dispatcherContent = dispatcherContent.replace(INTERNAL_LINK_ENTRY, NEW_ENTRY)
  fs.writeFileSync(FILES.dispatcher, dispatcherContent, 'utf8')
  console.log(`✅ patched ${path.relative(ROOT, FILES.dispatcher)}`)
}

console.log('')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('Session 4 wire-up complete: framer_update_marketing_page_text')
console.log('═══════════════════════════════════════════════════════════════════')
console.log('')
console.log('1. Verify TypeScript:  npx tsc --noEmit')
console.log('')
console.log('2. Deploy:')
console.log('   git add -A && git commit -m "feat: framer_update_marketing_page_text executor (P0 session 4)"')
console.log('   git push origin main')
console.log('')
console.log('3. Canvas API caveat:')
console.log('   This executor uses framer-api canvas methods (getNodesWithAttribute,')
console.log('   getNodesWithType, setText) which are documented in Framer Plugin API')
console.log('   reference but UNTESTED in our integration. If they fail at runtime')
console.log('   with CANVAS_API_UNAVAIL, the framer-api package version may not expose')
console.log('   canvas APIs and needs upgrading. Error message includes the specific')
console.log('   method that failed so we know what to fix.')
console.log('')
console.log('4. Test path:')
console.log('   - Pick a known phrase on Tarino /about (or /contact)')
console.log('   - Ask agent in Slack: propose updating "<exact phrase>" to "<new>"')
console.log('     using framer_update_marketing_page_text')
console.log('   - Approve the card')
console.log('   - Verify on tarino.au/<page>: text updated; page still renders')
console.log('   - If failure: check error code (PAGE_NOT_FOUND, TEXT_NOT_FOUND,')
console.log('     AMBIGUOUS_TEXT, CANVAS_API_UNAVAIL) for diagnosis')
