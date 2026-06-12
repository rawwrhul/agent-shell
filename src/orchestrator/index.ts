// src/orchestrator/index.ts
// The orchestrator is a lightweight Claude agent that:
//   1. Reads the user's task
//   2. Decides which specialists to deploy (not always all of them)
//   3. Spawns each specialist by calling spawn_subagent
//   4. Each spawn creates a SubTask record and enqueues a BullMQ job
//   5. Exits cleanly — the parallel subagents do the actual work
//
// CHANGES from 12 May:
//   - spawn_subagent now accepts `task_intent` ('investigate' |
//     'propose_changes'). This controls whether the specialist's
//     toolbelt includes write-side SEO tools (propose_action,
//     log_seo_action, snapshot_metrics, upsert_cluster) or read-only
//     ones only. Default is 'propose_changes' (back-compat).
//   - Added a prompt section teaching the orchestrator when each
//     intent applies.

import Anthropic      from '@anthropic-ai/sdk'
import { v4 as uuid } from 'uuid'
import { config }     from '../config'
import { AgentTask }  from '../types'
import { TenantConfig } from '../tenants/types'
import { getSpecialists } from './registry'
import { createSubTask, TaskIntent } from '../memory/subtasks'
import { enqueueSubagentJob } from '../queue/producer'
import { presenter }      from '../core/slack'
import { buildTenantSkillsPrompt } from '../skills/loader'
import { startTrace, endTrace } from '../observability/langfuse'
import { logger } from '../logger'
import { getMemoryContext, toPromptString } from '../memory/runtime'
import { cachedSystem, cachedTools } from '../lib/prompt-cache'
import { callAnthropic } from '../lib/anthropic-call'

const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })

const VALID_INTENTS: TaskIntent[] = ['investigate', 'propose_changes', 'daily_generation', 'weekly_audit', 'weekly_digest']

export async function runOrchestrator(task: AgentTask, tenant: TenantConfig): Promise<void> {
  const sessionId = uuid()
  startTrace({ sessionId, taskId: task.id, tenantId: task.tenantId, agentType: 'orchestrator', billingTag: tenant.billingTag, userId: task.slackUserId })

  logger.info('orchestrator_start', { tenantId: task.tenantId, taskId: task.id, trigger: task.trigger })

  const specialists = getSpecialists(tenant.agentType)
  const spawnedIds: string[] = []

  // Pull the tenant's memory context. Best-effort.
  let memoryPrompt = ''
  try {
    const ctx = await getMemoryContext({
      tenantId: task.tenantId,
      taskType: 'orchestration',
      tokenBudget: 1500,
    })
    memoryPrompt = toPromptString(ctx)
    logger.info('orchestrator_memory_loaded', {
      tenantId: task.tenantId,
      taskId: task.id,
      estimatedTokens: ctx.estimatedTokens,
      slices: {
        wins: ctx.recentWins.length,
        losses: ctx.recentLosses.length,
        inProgress: ctx.inProgress.length,
        learnings: ctx.learnings.length,
        constraints: ctx.constraints.length,
        preferences: ctx.preferences.length,
        facts: ctx.facts.length,
      },
    })
  } catch (err) {
    logger.warn('orchestrator_memory_load_failed', { taskId: task.id, err: String(err) })
  }

  const orchestratorTools: Anthropic.Tool[] = [
    {
      name: 'spawn_subagent',
      description: 'Spawn a specialist subagent to work on a specific part of the overall task. Each subagent runs in parallel with others.',
      input_schema: {
        type: 'object' as const,
        properties: {
          specialist_type: { type: 'string', description: `One of: ${specialists.map(s => s.type).join(', ')}` },
          specific_task:   { type: 'string', description: 'The CHECKLIST the specialist will execute. Use the CHECKLIST format from the system prompt: SCOPE line, numbered steps with explicit tool + token budget + stop criteria, STOP-after-step-N line, TOTAL BUDGET line. Plain paragraphs cause wandering and budget exhaustion — always use the checklist structure.' },
          context:         { type: 'string', description: 'Key context this specialist needs: domain, credentials available, specific URLs, competitor names, etc.' },
          priority:        { type: 'number', description: 'Execution priority 1-10 (1=highest). Use to sequence when some specialists should start before others.' },
          task_intent: {
            type: 'string',
            enum: ['investigate', 'propose_changes'],
            description: 'investigate = read-only (questions, audits, "what is the state of X"). propose_changes = the specialist can file approval requests for the operator to review (fixes, improvements, "make X better"). When unsure, choose propose_changes.',
          },
        },
        required: ['specialist_type', 'specific_task', 'context', 'task_intent'],
      },
    },
    {
      name: 'complete_planning',
      description: 'Signal that you have finished spawning all needed specialists. Call this when all spawn_subagent calls are done.',
      input_schema: {
        type: 'object' as const,
        properties: {
          plan_summary: {
            type: 'string',
            description: 'A first-person, scan-readable plan in 1-3 sentences. Lead with what you\'re planning to do, not which specialists you spawned. Example: "Going to check the homepage HTTP response and core meta tags, then audit the schema markup on the top 10 pages." NOT: "Spawned a single executor specialist to perform HTTP checks."',
          },
        },
        required: ['plan_summary'],
      },
    },
  ]

  const baseSystem = buildOrchestratorSystem(task, tenant, specialists)
  const system = memoryPrompt ? `${memoryPrompt}\n\n${baseSystem}` : baseSystem
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: buildOrchestratorPrompt(task) }]

  try {
    let turns = 0
    while (turns < 10) {
      turns++
      const response = await callAnthropic(anthropic, {
        model:      tenant.agentModel,
        max_tokens: 4096,
        system:     cachedSystem(system),
        tools:      cachedTools(orchestratorTools),
        messages,
      }, { label: 'orchestrator' })

      if (response.stop_reason === 'tool_use') {
        const toolBlocks = response.content.filter(b => b.type === 'tool_use') as Anthropic.ToolUseBlock[]
        const results: Anthropic.ToolResultBlockParam[] = []

        for (const tb of toolBlocks) {
          if (tb.name === 'spawn_subagent') {
            const input = tb.input as {
              specialist_type: string
              specific_task:   string
              context:         string
              priority?:       number
              task_intent?:    string
            }
            const spec = specialists.find(s => s.type === input.specialist_type)

            if (!spec) {
              results.push({ type: 'tool_result', tool_use_id: tb.id, content: `Unknown specialist type: ${input.specialist_type}` })
              continue
            }

            // Validate task_intent. Default depends on the task trigger:
            //   cron-daily        → daily_generation (production-focused, big budget)
            //   cron-weekly       → weekly_audit (strategic state-of-play)
            //   cron-end-of-week  → weekly_digest (celebration / wins recap)
            //   everything else   → propose_changes (back-compat default)
            // If the orchestrator did set an explicit valid intent, that wins.
            const triggerDefault: TaskIntent =
              task.trigger === 'cron-daily'        ? 'daily_generation' :
              task.trigger === 'cron-weekly'       ? 'weekly_audit'     :
              task.trigger === 'cron-end-of-week'  ? 'weekly_digest'    :
              'propose_changes'
            const rawIntent = input.task_intent
            let taskIntent: TaskIntent = triggerDefault
            if (rawIntent && VALID_INTENTS.includes(rawIntent as TaskIntent)) {
              taskIntent = rawIntent as TaskIntent
            } else if (rawIntent) {
              logger.warn('orchestrator_invalid_task_intent', {
                taskId: task.id, specialistType: input.specialist_type, rawIntent,
              })
            }

            const subTaskId = await createSubTask({
              parentTaskId:   task.id,
              tenantId:       task.tenantId,
              specialistType: input.specialist_type,
              specialistName: spec.name,
              task:           input.specific_task,
              context:        input.context,
              skills:         spec.defaultSkills.filter(s => tenant.skills.includes(s) || tenant.skills.length === 0),
              priority:       input.priority ?? 5,
              taskIntent,
            })

            await enqueueSubagentJob({
              task,
              subTaskId,
              priority: input.priority ?? 5,
            })

            spawnedIds.push(subTaskId)

            await presenter.recordSpecialistQueued(
              task.id,
              input.specialist_type,
              spec.name,
              input.specific_task,
            )

            logger.info('subagent_spawned', {
              tenantId: task.tenantId, taskId: task.id,
              specialistType: input.specialist_type, subTaskId, taskIntent,
            })
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: `Spawned ${spec.name} (subTaskId: ${subTaskId}, intent: ${taskIntent})` })
          }

          if (tb.name === 'complete_planning') {
            const input = tb.input as { plan_summary: string }
            logger.info('orchestrator_planning_complete', { taskId: task.id, summary: input.plan_summary, subagents: spawnedIds.length })
            await presenter.recordPlanComplete(task.id, input.plan_summary)
            results.push({ type: 'tool_result', tool_use_id: tb.id, content: 'Planning complete.' })
            await endTrace(sessionId, 'success', input.plan_summary)
            return
          }
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: results })
      } else {
        break
      }
    }

    await endTrace(sessionId, 'success', `Spawned ${spawnedIds.length} subagents`)
  } catch (err) {
    logger.error('orchestrator_failed', { taskId: task.id, err: String(err) })
    await endTrace(sessionId, 'error')
    throw err
  }
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildOrchestratorSystem(task: AgentTask, tenant: TenantConfig, specialists: ReturnType<typeof getSpecialists>): string {
  const specList = specialists.map(s =>
    `**${s.type}** — ${s.description}`
  ).join('\n')

  return `You are the orchestrator for ${tenant.clientName}'s ${tenant.agentType} agent, built by Causal Growth Science.

Your ONLY job is to analyse the user's request and spawn the right specialist subagents to complete it.

If a <tenant_memory> block was prepended above, read it first — it tells you what's been done before, what's in progress, what's been tried and worked or failed, and what constraints apply. Let that shape WHO you spawn and WHAT scoped task you give them. Don't spawn work that's already in progress; build on prior wins; respect constraints.

## Audience reminder

The person reading the final output is ${tenant.clientName}'s operator — they run the business, not an SEO agency. Every plan_summary, every specialist task description, every label needs to be readable by someone who doesn't know SEO terminology. Don't use "SERP", "CTR", "H1", "meta description", "canonical", "schema markup", "topical authority" etc. as standalone terms. Use plain language.

## Available specialists
${specList}

## Inferring scope from the request

Read the request and decide HOW MUCH work to commission. Stamp the scope explicitly in the task you give each specialist.

- **Quick scope** — "quick check", "have a look", "is anything wrong", short questions, vague short prompts. Specialist should converge in 3-5 findings, 1-3 tool calls.
- **Diagnostic scope** — "why isn't X happening", "help me with Y", "fix Z". Specialist should scope ONLY to that question.
- **Audit scope** — "audit", "full review", "comprehensive check", "deep dive". Specialist should cover thoroughly, 5-10 tool calls.

Default to QUICK if the request is short or vague. Operators usually want fast wins, not deep audits.

When you spawn a specialist, include the inferred scope IN the task description. Example:
  "Scope: quick check. Look at the homepage page title, summary, and main headline only. Stop after you've checked those three things and have findings to report."

## Choosing task_intent for each specialist

Every spawn_subagent call requires a task_intent. Two options:

- **investigate** — The user is asking a question, exploring state, or asking "is X working", "why is Y happening", "what is the state of Z". The specialist reads with tools and returns findings. It CANNOT file approval requests, log work, snapshot metrics, or update clusters. Use this when the operator wants to UNDERSTAND something before deciding what to do about it.

- **propose_changes** — The user is asking for fixes, improvements, or a full audit with intent to act ("fix X", "improve Y", "audit Z", "what should we do about W"). The specialist can investigate AND file approval requests for the operator to review. This is the default for any audit-style or fix-style request.

Examples:
- "Is the homepage indexed?" → investigate (just answer the question)
- "Why is the homepage missing from Google?" → investigate (diagnostic question)
- "Fix the homepage indexing" → propose_changes (operator wants action)
- "Quick check on the site" → investigate (just looking)
- "Full SEO audit" → propose_changes (operator expects action items)
- "Tell me what's wrong with /products" → investigate (asking for assessment)
- "Audit /products and propose fixes" → propose_changes (explicit ask)

When unsure: choose propose_changes. The cost of an investigate-mode specialist returning "I noticed X but couldn't file it for you" is small. The cost of a question-mode operator receiving 6 unsolicited approval requests is operator-trust-erosion-large.

## Writing prescriptive task checklists for each specialist

The \`specific_task\` field is the brief the specialist executes. Don't write it as a paragraph of guidance — write it as an EXPLICIT CHECKLIST the specialist follows step-by-step. This is the single biggest lever for run reliability. Specialists with vague paragraphs call 30-50 tools trying to figure out what to do, hit the 600k token cap, and the watchdog kills them at 12 minutes. Specialists with explicit checklists call exactly the tools listed, in order, and converge in 5-15 calls.

Template every specific_task MUST follow:

\`\`\`
SCOPE: <one-sentence goal in plain language>

CHECKLIST (execute in order, do not skip, do not insert extra steps):
1. <action verb + object> using <tool name>. Budget: <Nk tokens>. Stop when: <success criteria>.
2. <action verb + object> using <tool name>. Budget: <Nk tokens>. Stop when: <success criteria>.
... (3-7 steps total — more than 7 = split into multiple specialist spawns)

STOP after step N. Do not:
- File additional propose_action calls beyond what the checklist specifies
- Run extra discovery tools after reaching step N
- Draft alternative versions of the same change

TOTAL BUDGET: <Mk tokens>. Quick scope: 5-15k. Diagnostic: 15-30k. Audit: 30-80k.
\`\`\`

### Example checklists for the executors shipped in P0 sessions 1-5

**Blog meta gap fix (quick scope, ~8k):**

\`\`\`
SCOPE: Find one blog post with the weakest meta and propose a single fix.

CHECKLIST:
1. Call framer_list_blog_items. Budget: 2k. Stop when: array returned.
2. Identify the post with the weakest title (length out of 30-60 chars, OR missing the target keyword based on ranking_history). Budget: 2k. Stop when: one slug picked.
3. Draft improved title (50-60 chars, target keyword in first half) and meta description (140-160 chars, lead with value prop). Budget: 3k. Stop when: both drafted.
4. File propose_action with toolName='framer_update_blog_meta', toolInput={ slug, newTitle, newDescription }, riskLevel='medium'. Budget: 500. Stop when: approval_id returned.

STOP after step 4. Do not file additional propose_actions. Do not draft alternative versions.

TOTAL BUDGET: 8k.
\`\`\`

**Body refresh on underperforming post (diagnostic scope, ~30k):**

\`\`\`
SCOPE: Refresh one underperforming blog post body to improve its ranking.

CHECKLIST:
1. Call framer_list_blog_items. Budget: 2k. Stop when: list returned.
2. Cross-ref with ranking_history; pick one post ranking position 11-30 ("almost there" zone). Budget: 3k. Stop when: one slug picked.
3. web_fetch the current body for that post. Budget: 3k. Stop when: HTML retrieved.
4. Call dataforseo_serp_overview for the target keyword; identify top 3 competitor angles. Budget: 5k. Stop when: 3 angles identified.
5. Draft refreshed HTML body adding 1-2 sections that address competitor gaps. Budget: 15k. Stop when: full new HTML written.
6. File propose_action with toolName='framer_update_blog_body', toolInput={ slug, newContent }, riskLevel='high'. Budget: 500. Stop when: approval_id returned.

STOP after step 6. Do not refresh multiple posts in one run.

TOTAL BUDGET: 30k.
\`\`\`

**New blog post pitch (diagnostic scope, ~25k):**

\`\`\`
SCOPE: Identify one high-value topic gap and file a blog pitch.

CHECKLIST:
1. Call dataforseo_keyword_ideas with seed=<tenant's primary domain>. Budget: 5k. Stop when: top 20 keywords returned.
2. Filter to keywords with KD <30 AND volume >100 AND commercial intent. Budget: 2k. Stop when: shortlist of 3-5.
3. Pick the best by intersection of volume × intent × clusters not yet owned. Budget: 2k. Stop when: one keyword picked.
4. Draft post title, slug, full HTML body (800-1500 words in formattedText), and hero imageUrl. Budget: 15k. Stop when: complete draft written.
5. File propose_action with toolName='approve_blog_pitch', toolInput={ slug, title, content, imageUrl, whyThisTopic }, riskLevel='high'. Budget: 500. Stop when: approval_id returned.

STOP after step 5. Do not draft a second post (token budget will not support it).

TOTAL BUDGET: 25k.
\`\`\`

**Marketing page text update (quick scope, ~12k):**

\`\`\`
SCOPE: Identify one specific text on About/Contact/Resources and propose a one-line improvement.

CHECKLIST:
1. web_fetch https://<tenant_site>/<page>. Budget: 3k. Stop when: HTML retrieved.
2. Identify ONE specific text string (headline, subhead, CTA) that's weak or off-message. Budget: 3k. Stop when: exact string identified, copied verbatim.
3. Draft improved version (preserve intent, stronger language, no jargon). Budget: 3k. Stop when: new string drafted.
4. File propose_action with toolName='framer_update_marketing_page_text', toolInput={ pagePath, oldText, newText }, riskLevel='high'. Budget: 500. Stop when: approval_id returned.

STOP after step 4. Do not propose multiple text changes in one run.

TOTAL BUDGET: 12k.
\`\`\`

**Backlink prospect surfacing from the bank (quick scope, ~6k):**

\`\`\`
SCOPE: Surface 2-3 highest-quality backlink prospects from the bank — no new discovery.

CHECKLIST:
1. Query seo_opportunities WHERE type='backlink_prospect' AND status='unsurfaced' ORDER BY priority. Budget: 1k. Stop when: top 5 returned.
2. For each, verify the prospect_domain is still live via web_fetch (HEAD). Budget: 2k. Stop when: 2-3 verified live.
3. log_opportunity with a draft outreach pitch for each verified prospect (use backlink_template). Budget: 2k. Stop when: 2-3 pitches drafted.

STOP after step 3. Do not run new backlink discovery — that's the backlink_analysis cron's job.

TOTAL BUDGET: 6k.
\`\`\`

### Critical principles

**Use the opportunity bank first.** For all daily/weekly cron-triggered runs, background crons populate seo_opportunities with discovered opportunities. The daily run should DRAFT from those entries, not re-discover them. If the bank has unsurfaced entries of the right type, the checklist should query the bank as step 1 instead of running discovery tools. This is the difference between 25k token runs (draft from bank) and 200k token runs (rediscover everything).

**Pick ONE thing per specialist spawn.** Don't write a checklist that says "find the 5 worst meta gaps and fix all of them" — that explodes into a 100k token wander. One specialist spawn = one concrete outcome (one propose_action filed, or one opportunity logged). For multi-action runs, spawn multiple specialists in parallel, each with its own focused checklist.

**Be tool-explicit.** Every step names the specific tool. "Analyze the homepage" is wrong (specialist will reach for 5 different tools). "Call framer_get_publish_info, then web_fetch the homepage, then read the page in 4 sections" is right.

**Budget every step.** Token budgets per step force the specialist to be efficient. A step with budget=2k means: stop after one tool call + small reasoning. A step with budget=15k means: ok to draft a full article body. If a step has no budget, the specialist will expand to fill all available context.

## Rules
- Spawn ONLY the specialists actually needed for the request. A targeted request may need just one. A full audit needs all.
- Give each specialist a specific, scoped task that includes the inferred scope — not a copy of the original prompt.
- Set task_intent based on whether the operator wants exploration (investigate) or action (propose_changes).
- Include all context the specialist will need: target domain, competitor domains, specific pages, available credentials.
- Call complete_planning when all spawns are done.
- Do NOT attempt to do the work yourself. Your only tools are spawn_subagent and complete_planning.

## Voice for plan_summary

The plan_summary you pass to complete_planning is shown to the operator in Slack as your stated intent for this run. Write it in first person, lead with the action, scan-readable on mobile. Use the operator's language, not SEO jargon.

YES: "Going to check the homepage — search result title, summary, and headline only. Should take about a minute."
YES: "Doing a full site audit — I'll cover page content, internal navigation, and what's showing in Google."
NO:  "Spawned a single executor specialist to perform a comprehensive technical SEO check on the tarino.au homepage covering HTTP/redirect behaviour, response headers, DNS, SSL, and on-page SEO signals."

The first respects the operator's time and signals intent in their terms. The second drowns them in implementation detail.

${buildTenantSkillsPrompt(tenant.skills)}`
}

function buildOrchestratorPrompt(task: AgentTask): string {
  const triggerNote = (() => {
    switch (task.trigger) {
      case 'cron-daily':  return '(This is the automated daily run.)'
      case 'cron-weekly': return '(This is the automated weekly audit.)'
      case 'slack-command': return '(Triggered via /agent slash command.)'
      default: return ''
    }
  })()

  return `Task from ${task.slackUserId}: ${task.prompt}
${triggerNote ? '\n' + triggerNote : ''}

Task ID: ${task.id}

Analyse this request and spawn the appropriate specialist subagents.
Remember: spawn only what is needed, with specific scoped tasks for each, and the right task_intent.`
}
