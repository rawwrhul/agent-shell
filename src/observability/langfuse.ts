import { Langfuse } from 'langfuse'
import { config } from '../config'

const lf = new Langfuse({
  publicKey:  config.LANGFUSE_PUBLIC_KEY,
  secretKey:  config.LANGFUSE_SECRET_KEY,
  baseUrl:    config.LANGFUSE_HOST,
  flushAt:    10,
  flushInterval: 5000,
})

const traces = new Map<string, ReturnType<typeof lf.trace>>()

export function startTrace(p: { sessionId: string; taskId: string; tenantId: string; agentType: string; billingTag: string; userId?: string }) {
  const t = lf.trace({
    id:        p.sessionId,
    name:      `agent:${p.agentType}`,
    sessionId: p.taskId,
    userId:    p.userId,
    metadata:  { tenantId: p.tenantId, agentType: p.agentType },
    tags:      [p.agentType, p.billingTag, config.NODE_ENV],
  })
  traces.set(p.sessionId, t)
  return t
}

export async function trace(p: { name: string; sessionId: string; taskId: string; input?: unknown; output?: unknown; metadata?: Record<string,unknown> }) {
  traces.get(p.sessionId)?.span({ name: p.name, input: p.input, output: p.output, metadata: p.metadata })
}

export function recordUsage(sessionId: string, model: string, inputTokens: number, outputTokens: number) {
  traces.get(sessionId)?.generation({ name: 'session', model, usage: { input: inputTokens, output: outputTokens } })
}

export async function endTrace(sessionId: string, status: 'success'|'error', summary?: string) {
  traces.get(sessionId)?.update({ metadata: { endStatus: status, summary } })
  traces.delete(sessionId)
  await lf.flushAsync()
}
