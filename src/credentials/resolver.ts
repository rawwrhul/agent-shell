import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { config }  from '../config'
import { logger }  from '../logger'

const client = new SecretManagerServiceClient()
const cache  = new Map<string, { value: string; exp: number }>()
const TTL    = 10 * 60 * 1000

export async function getSharedCredential(key: string)                       { return resolve(`cgs-${key}`) }
export async function getClientCredential(tenantId: string, key: string)     { return resolve(`${tenantId}-${key}`) }

export async function buildCredentialContext(tenantId: string, agentType: string) {
  const { AGENT_CREDENTIAL_MANIFESTS, CGS_CREDENTIALS } = await import('./manifest')
  const available: Record<string, string> = {}
  const missing: string[] = []

  for (const c of CGS_CREDENTIALS) {
    const v = await getSharedCredential(c.key)
    if (v) available[c.key] = v
  }

  for (const c of (AGENT_CREDENTIAL_MANIFESTS[agentType] ?? [])) {
    const v = await getClientCredential(tenantId, c.key)
    if (v)              available[c.key] = v
    else if (c.required) missing.push(c.label)
  }

  return { available, missing }
}

export function formatCredentialsForPrompt(available: Record<string, string>): string {
  if (!Object.keys(available).length) return ''
  return ['## Available credentials', '', ...Object.entries(available).map(([k, v]) => `- ${k}: ${v}`), '', 'Use these directly in tool calls.'].join('\n')
}

async function resolve(secretId: string): Promise<string | null> {
  const hit = cache.get(secretId)
  if (hit && hit.exp > Date.now()) return hit.value
  const name = `projects/${config.GCP_PROJECT_ID}/secrets/${secretId}/versions/latest`
  try {
    const [v] = await client.accessSecretVersion({ name })
    const val  = v.payload?.data?.toString() ?? ''
    cache.set(secretId, { value: val, exp: Date.now() + TTL })
    return val
  } catch {
    return null
  }
}
