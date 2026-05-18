/**
 * Delete the bot's own messages in a tenant's Slack channel.
 *
 * Usage: npx tsx clean-slack.ts <tenantId> [hoursBack]
 */
import { WebClient } from '@slack/web-api'
import { getTenant } from './src/tenants/registry'

async function main() {
  const tenantId  = process.argv[2]
  const hoursBack = Number(process.argv[3] ?? 24)

  if (!tenantId) {
    console.error('Usage: npx tsx clean-slack.ts <tenantId> [hoursBack]')
    process.exit(1)
  }

  const tenant = await getTenant(tenantId)
  const slack  = new WebClient(tenant.slackBotToken)

  const channelId = tenant.slackChannelId
  const oldestTs  = (Date.now() / 1000 - hoursBack * 3600).toString()

  console.log(`Tenant: ${tenantId}`)
  console.log(`Channel: ${channelId}`)
  console.log(`Looking back: ${hoursBack}h`)

  const auth = await slack.auth.test()
  const botUserId = auth.user_id
  console.log(`Bot user: ${auth.user} (${botUserId})`)

  let cursor: string | undefined
  let totalSeen = 0
  let totalDeleted = 0
  let totalFailed = 0

  do {
    const res = await slack.conversations.history({
      channel: channelId,
      oldest:  oldestTs,
      limit:   200,
      cursor,
    })

    const msgs = res.messages ?? []
    totalSeen += msgs.length

    for (const m of msgs) {
      const isBotMsg = m.user === botUserId || m.bot_id != null
      if (!isBotMsg) continue
      if (!m.ts) continue

      try {
        await slack.chat.delete({ channel: channelId, ts: m.ts })
        totalDeleted++
        process.stdout.write('.')
        await new Promise(r => setTimeout(r, 1100))
      } catch (err: any) {
        totalFailed++
        process.stdout.write('x')
        if (err?.data?.error !== 'message_not_found') {
          console.error('\n  err:', err?.data?.error ?? err?.message ?? err)
        }
      }
    }

    cursor = res.response_metadata?.next_cursor || undefined
  } while (cursor)

  console.log('')
  console.log(`Seen:    ${totalSeen}`)
  console.log(`Deleted: ${totalDeleted}`)
  console.log(`Failed:  ${totalFailed}`)
}

main().catch(err => { console.error(err); process.exit(1) })
