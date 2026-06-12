import { Pool } from 'pg'
import { config } from '../config'
import { RunRecord, AgentStatus } from '../types'

export const pool = new Pool({ connectionString: config.DATABASE_URL })

export async function createRunRecord(p: { id: string; tenantId: string; taskId: string; agentType: string; sessionId: string }) {
  await pool.query(
    `INSERT INTO run_records (id, tenant_id, task_id, agent_type, session_id, started_at, token_count, tool_call_count, status)
     VALUES ($1,$2,$3,$4,$5,NOW(),0,0,'running')`,
    [p.id, p.tenantId, p.taskId, p.agentType, p.sessionId]
  )
}

export async function completeRunRecord(p: { id: string; status: AgentStatus; tokenCount: number; toolCallCount: number; summary?: string; error?: string }) {
  await pool.query(
    `UPDATE run_records SET completed_at=NOW(), status=$2, token_count=$3, tool_call_count=$4, summary=$5, error=$6 WHERE id=$1`,
    [p.id, p.status, p.tokenCount, p.toolCallCount, p.summary ?? null, p.error ?? null]
  )
}

export async function getRunHistory(taskId: string, tenantId: string): Promise<RunRecord[]> {
  // tenant_id predicate is an isolation guard: task UUIDs leak into logs
  // and screenshots, and /agent history must never show another tenant's
  // runs to whoever pastes one.
  const res = await pool.query(
    'SELECT * FROM run_records WHERE task_id=$1 AND tenant_id=$2 ORDER BY started_at ASC',
    [taskId, tenantId])
  return res.rows
}

export async function getTokenSpend(agentType: string, tenantId: string, since?: Date): Promise<number> {
  const res = await pool.query(
    `SELECT COALESCE(SUM(token_count),0) as total FROM run_records
     WHERE agent_type=$1 AND tenant_id=$2 AND ($3::timestamptz IS NULL OR started_at>=$3)`,
    [agentType, tenantId, since ?? null]
  )
  return Number(res.rows[0].total)
}
