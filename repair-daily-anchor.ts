/**
 * One-off repair: regenerate today's daily-run anchor with specific
 * approval card titles pulled directly from approval_requests.tool_input.
 *
 * Usage: npx tsx repair-daily-anchor.ts <task_id>
 *
 * Background:
 *   The aggregator's synthesis LLM only sees specialist narrative output,
 *   not approval_requests rows. When the narrative is vague, card titles
 *   come out generic ("On-page improvement #1"). This script rebuilds
 *   awaitingApproval[] from the actual DB rows and updates the anchor.
 *
 * Safe to run on any completed daily run. Does not touch approval_requests,
 * does not touch any other state. Only re-renders + slack.chat.update.
 */
import { WebClient } from '@slack/web-api'
import { Pool } from 'pg'
import { renderDailyRun } from './src/core/slack/blocks/daily-run'
import { getTenant } from './src/tenants/registry'
import type { DailyRunReport, ApprovalItem } from './src/core/slack/blocks/types'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1) }

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })

function extractTitle(toolName: string, toolInput: any): string {
  if (toolName === 'manual_operator_task') {
    const instr = String(toolInput?.instruction || '').trim()
    if (!instr) return `Manual task — ${toolInput?.category || 'general'}`
    // First sentence (up to . or newline), capped at 180 chars
    const firstSentence = instr.split(/[.\n]/)[0].trim()
    return firstSentence.slice(0, 180)
  }
  if (toolName === 'outreach_send_mailto') {
    const target = toolInput?.target_site || '(target unknown)'
    const kind = String(toolInput?.prospect_kind || 'outreach').replace(/_/g, ' ')
    return `Outreach: ${kind} → ${target}`
  }
  if (toolName === 'framer_create_and_publish_blog_post') {
    const t = toolInput?.post_title || toolInput?.title || toolInput?.blog_title
    return t ? `Publish blog post: "${t}"` : 'Publish new blog post'
  }
  return toolName.replace(/_/g, ' ')
}

function extractDetail(toolName: string, toolInput: any, riskReason: string): string {
  if (toolName === 'manual_operator_task') {
    const instr = String(toolInput?.instruction || '').trim()
    // Everything after the first sentence, capped
    const rest = instr.split(/[.\n]/).slice(1).join('. ').trim()
    if (rest) return rest.slice(0, 350)
    return String(riskReason || '').slice(0, 350)
  }
  if (toolName === 'outreach_send_mailto') {
    const url = toolInput?.source_url
    const subj = toolInput?.drafted_subject
    if (subj && url && url !== '(unknown)') return `${subj} — source: ${url}`
    return String(riskReason || '').slice(0, 350)
  }
  if (toolName === 'framer_create_and_publish_blog_post') {
    const url = toolInput?.target_url || toolInput?.url || toolInput?.proposed_url
    return url ? `Target URL: ${url}` : String(riskReason || '').slice(0, 350)
  }
  return String(riskReason || '').slice(0, 350)
}

function severityFor(toolName: string): ApprovalItem['severity'] {
  if (toolName === 'framer_create_and_publish_blog_post') return 'high'
  if (toolName === 'manual_operator_task') return 'medium'
  return 'medium'
}

async function main() {
  const taskId = process.argv[2]
  if (!taskId) { console.error('Usage: npx tsx repair-daily-anchor.ts <task_id>'); process.exit(1) }

  // Load slack_runs to get channel + anchor_ts + current state
  const { rows: [run] } = await pool.query(
    `SELECT task_id, tenant_id, channel_id, anchor_ts, state FROM slack_runs WHERE task_id = $1`,
    [taskId]
  )
  if (!run) { console.error('No slack_runs row for task_id', taskId); process.exit(1) }

  console.log('Tenant:', run.tenant_id)
  console.log('Channel:', run.channel_id)
  console.log('Anchor TS:', run.anchor_ts)

  const existingReport: DailyRunReport | undefined = run.state?.finalReport
  if (!existingReport || existingReport.kind !== 'daily') {
    console.error('No daily report in state, or kind mismatch:', existingReport?.kind)
    process.exit(1)
  }

  // Query the actual approval_requests rows for this task
  const { rows: approvals } = await pool.query(
    `SELECT id, tool_name, tool_input, risk_reason, requested_at
     FROM approval_requests
     WHERE task_id = $1 AND status = 'pending'
     ORDER BY requested_at ASC`,
    [taskId]
  )

  console.log(`Found ${approvals.length} pending approval rows in DB`)

  // Build corrected awaitingApproval[] from real data
  const corrected: ApprovalItem[] = approvals.map(a => ({
    id:           a.id,
    title:        extractTitle(a.tool_name, a.tool_input),
    detail:       extractDetail(a.tool_name, a.tool_input, a.risk_reason),
    pendingSince: new Date(a.requested_at),
    severity:     severityFor(a.tool_name),
  }))

  console.log('\nCorrected titles:')
  corrected.forEach((c, i) => console.log(`  ${i+1}. ${c.title}`))

  // Build the new report — same as existing but with corrected approvals
  const newReport: DailyRunReport = {
    ...existingReport,
    // Re-coerce dates that may have been JSON-serialized as strings
    runDate:     new Date(existingReport.runDate),
    nextRunAt:   existingReport.nextRunAt ? new Date(existingReport.nextRunAt) : undefined,
    awaitingApproval: corrected,
  }

  // Render new blocks
  const rendered = renderDailyRun(newReport)

  // Update Slack in place — same channel + ts → existing message gets edited
  const tenant = await getTenant(run.tenant_id)
  const slack  = new WebClient(tenant.slackBotToken)

  await slack.chat.update({
    channel: run.channel_id,
    ts:      run.anchor_ts,
    text:    rendered.text,
    blocks:  rendered.blocks as any,
  })

  // Persist the corrected report back to slack_runs.state so future
  // mutations (approve/reject) render from the fixed version
  await pool.query(
    `UPDATE slack_runs
       SET state = jsonb_set(state, '{finalReport}', $1::jsonb),
           updated_at = NOW()
     WHERE task_id = $2`,
    [JSON.stringify(newReport), taskId]
  )

  console.log('\n✓ Anchor updated + state persisted')
  await pool.end()
}

main().catch(err => { console.error(err); pool.end(); process.exit(1) })
