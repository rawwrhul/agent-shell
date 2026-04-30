import 'dotenv/config'
import { z } from 'zod'

const schema = z.object({
  ANTHROPIC_API_KEY:  z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  GCP_PROJECT_ID:     z.string().min(1, 'GCP_PROJECT_ID is required'),
  GCP_REGION:         z.string().default('us-central1'),
  DATABASE_URL:       z.string().min(1, 'DATABASE_URL is required'),
  REDIS_HOST:         z.string().min(1, 'REDIS_HOST is required'),
  REDIS_PORT:         z.coerce.number().default(6379),
  REDIS_PASSWORD:     z.string().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().min(1, 'LANGFUSE_PUBLIC_KEY is required'),
  LANGFUSE_SECRET_KEY: z.string().min(1, 'LANGFUSE_SECRET_KEY is required'),
  LANGFUSE_HOST:      z.string().url().default('https://cloud.langfuse.com'),
  NODE_ENV:           z.enum(['development', 'staging', 'production']).default('development'),
  AGENT_MODEL:        z.string().default('claude-sonnet-4-6'),
  AGENT_MAX_TURNS:    z.coerce.number().default(50),
  SKILLS_DIR:         z.string().default('./skills'),
  PROGRESS_DIR:       z.string().default('./agent-progress'),
  TOKEN_BUDGET_PER_RUN:    z.coerce.number().default(100000),
  MAX_SESSIONS_PER_TASK:   z.coerce.number().default(20),
})

function load() {
  const r = schema.safeParse(process.env)
  if (!r.success) {
    const msgs = r.error.issues.map(i => `  • ${i.path.join('.')}: ${i.message}`)
    console.error(`\nConfiguration errors:\n${msgs.join('\n')}\n\nCheck your .env against .env.example\n`)
    process.exit(1)
  }
  return r.data
}

export const config = load()
export type Config = typeof config
