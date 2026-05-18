const fs = require('fs')
const path = require('path')

const patches = [
  // ─────────────────────────────────────────────────────────────────────
  // 1. Presenter: add removeApprovalFromAnchor — public method to
  //    remove a resolved approval from the anchor's awaitingApproval[]
  //    and trigger a re-render via the existing mutate pattern.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/core/slack/presenter.ts',
    label: 'presenter: removeApprovalFromAnchor public method',
    sentinel: 'removeApprovalFromAnchor',
    edits: [
      {
        old: `  async failRun(taskId: string, error: string): Promise<void> {
    await this.mutate(taskId, state => {
      if (state.phase === 'complete') return state;
      return { ...state, phase: 'failed', errorSummary: error };
    });
  }`,
        new: `  async failRun(taskId: string, error: string): Promise<void> {
    await this.mutate(taskId, state => {
      if (state.phase === 'complete') return state;
      return { ...state, phase: 'failed', errorSummary: error };
    });
  }

  /**
   * Remove a resolved approval from the anchor's awaitingApproval[] array
   * and re-render the anchor. Called by the HITL approve/reject handler
   * when the click happened on an in-anchor approval button (rather than
   * a threaded individual approval card).
   *
   * Without this, clicking approve on an anchor-embedded card would
   * overwrite the entire anchor message with the small approval-resolved
   * card content — the R3 inline-batched-approvals UI breaks on every click.
   */
  async removeApprovalFromAnchor(taskId: string, approvalId: string): Promise<void> {
    await this.mutate(taskId, state => {
      if (!state.finalReport) return state;
      const fr = state.finalReport;
      // Only daily/weekly/adhoc reports have awaitingApproval[].
      if (!('awaitingApproval' in fr) || !Array.isArray((fr as any).awaitingApproval)) return state;
      const filtered = (fr as any).awaitingApproval.filter((a: { id: string }) => a.id !== approvalId);
      // No change? skip the re-render.
      if (filtered.length === (fr as any).awaitingApproval.length) return state;
      return {
        ...state,
        finalReport: {
          ...(fr as any),
          awaitingApproval: filtered,
        },
      };
    });
  }`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 2. Handlers: detect anchor-source clicks and route to thread instead
  //    of in-place update. Without this, every approve/reject click on
  //    an anchor-embedded card destroys the daily-run anchor.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/hitl/handlers.ts',
    label: 'handlers: anchor-aware approval message handling',
    sentinel: 'anchor_aware_resolved_message',
    edits: [
      // Add presenter + slack_runs lookup imports
      {
        old: `import { updateApprovalRowStatus } from './sheets';`,
        new: `import { updateApprovalRowStatus } from './sheets';
import { presenter } from '../core/slack';
import { getRun } from '../core/slack/state-store';`,
      },
      // Replace the editMessageToResolved body to detect anchor clicks
      {
        old: `  await ctx.client.chat.update({
    channel: ctx.slackChannelId,
    ts:      ctx.slackMessageTs,
    text:    \`\${verb} — \${summary}\`,
    blocks,
  }).catch((err) => {
    logger.error('approval_message_edit_failed', {
      approvalId: ctx.approvalId, err: String(err),
    });
  });
}`,
        new: `  // anchor_aware_resolved_message:
  // Determine whether the click happened on the anchor message (inline
  // R3-batched approval card) or on a threaded individual approval card.
  // - Anchor click: post a thread reply with the resolved status and
  //   remove the resolved card from the anchor's awaitingApproval list.
  //   DO NOT chat.update the anchor — that would destroy the daily-run
  //   rendering.
  // - Threaded click: keep the original behaviour (edit the threaded
  //   card in place to show approved/rejected status).
  let isAnchorClick = false;
  try {
    const run = await getRun(pool(), resolved.taskId);
    if (run?.anchorTs && run.anchorTs === ctx.slackMessageTs) {
      isAnchorClick = true;
    }
  } catch (err) {
    logger.warn('anchor_detection_failed', {
      approvalId: ctx.approvalId, err: String(err).slice(0, 200),
    });
  }

  if (isAnchorClick) {
    await ctx.client.chat.postMessage({
      channel:   ctx.slackChannelId,
      thread_ts: ctx.slackMessageTs,
      text:      \`\${verb} — \${summary}\`,
      blocks,
    }).catch((err) => {
      logger.error('approval_thread_reply_failed', {
        approvalId: ctx.approvalId, err: String(err),
      });
    });
    // Remove the resolved card from the anchor + re-render.
    await presenter.removeApprovalFromAnchor(resolved.taskId, ctx.approvalId).catch((err) => {
      logger.warn('anchor_reapproval_remove_failed', {
        approvalId: ctx.approvalId, err: String(err).slice(0, 200),
      });
    });
    return;
  }

  // Threaded card: edit in place (original behaviour).
  await ctx.client.chat.update({
    channel: ctx.slackChannelId,
    ts:      ctx.slackMessageTs,
    text:    \`\${verb} — \${summary}\`,
    blocks,
  }).catch((err) => {
    logger.error('approval_message_edit_failed', {
      approvalId: ctx.approvalId, err: String(err),
    });
  });
}`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 3. Framer client: defensive fallback for confirmationHash. The
  //    preview response may put the hash in `confirmationHash` OR in
  //    `nextAction.confirmationHash` depending on Framer SDK version.
  //    When neither is present, log the full preview shape so we can
  //    diagnose without another live-customer failure.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/integrations/framer/client.ts',
    label: 'framer: defensive confirmationHash extraction + diagnostic',
    sentinel: 'framer_preview_missing_hash',
    edits: [
      {
        old: `  let publish: ConfirmPublishResult
  try {
    publish = await confirmPublish(tenant, draft.preview.confirmationHash)
  } catch (err) {`,
        new: `  // Defensive: prefer top-level confirmationHash, fall back to
  // nextAction.confirmationHash. Framer SDK has shifted this between
  // versions — accepting either keeps us forward + backward compatible.
  const previewHash = draft.preview?.confirmationHash
                   ?? draft.preview?.nextAction?.confirmationHash
                   ?? null
  if (!previewHash) {
    logger.error('framer_preview_missing_hash', {
      tenantId: tenant.tenantId,
      itemId:   draft.itemId,
      // Truncate but keep enough to diagnose the actual shape
      preview:  JSON.stringify(draft.preview ?? null).slice(0, 1500),
    })
    // Roll back the just-created item rather than leaving orphan content
    try { await removeBlogPost(tenant, draft.itemId) } catch { /* swallow */ }
    throw new Error('Framer preview returned no confirmationHash — see framer_preview_missing_hash log for full preview response')
  }

  let publish: ConfirmPublishResult
  try {
    publish = await confirmPublish(tenant, previewHash)
  } catch (err) {`,
      },
    ],
  },

  // ─────────────────────────────────────────────────────────────────────
  // 4. Framer tools.ts: same defensive extraction for the two-stage
  //    pitch flow. If draft step returns no hash, fail with diagnostics
  //    rather than filing a Stage 2 approval with confirmationHash=undefined.
  // ─────────────────────────────────────────────────────────────────────
  {
    file: 'src/integrations/framer/tools.ts',
    label: 'framer/tools: defensive confirmationHash on pitch draft',
    sentinel: 'framer_pitch_missing_hash',
    edits: [
      {
        old: `          confirmationHash: result.preview.confirmationHash,`,
        new: `          confirmationHash: (() => {
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
          })(),`,
      },
    ],
  },
]

let allDone = true
for (const p of patches) {
  const abs = path.resolve(process.cwd(), p.file)
  if (!fs.existsSync(abs)) { console.error('NOT FOUND:', p.file); process.exit(1) }
  const src = fs.readFileSync(abs, 'utf8')
  if (src.includes(p.sentinel)) {
    console.log('• ' + p.label + ': already patched')
    continue
  }
  allDone = false
  let next = src
  for (const e of p.edits) {
    if (!next.includes(e.old)) {
      console.error('ANCHOR NOT FOUND in ' + p.file)
      console.error('  Expected (first 200 chars):')
      console.error('  ' + e.old.slice(0, 200).replace(/\n/g, '\n  '))
      process.exit(1)
    }
    next = next.replace(e.old, e.new)
  }
  fs.writeFileSync(abs, next)
  console.log('✓ Patched ' + p.file)
}

if (allDone) console.log('all 4 patches already applied')
else console.log('done')
