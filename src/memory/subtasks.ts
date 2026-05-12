// src/memory/subtasks.ts
// Database operations for SubTask records.
// SubTasks are the parallel specialist jobs spawned by the orchestrator.
//
// CHANGES from 12 May:
//   - Added `task_intent` field. The orchestrator decides at spawn time
//     whether a specialist needs write capability (propose_changes) or
//     should be read-only (investigate). Tool filtering in subagent.ts
//     respects this.

import { pool } from './postgres'
import { logger } from '../logger'

export type TaskIntent = 'investigate' | 'propose_changes' | 'execute_approved'

export interface SubTask {
  id:              string
  parent_task_id:  string
  tenant_id:       string
  specialist_type: string
  specialist_name: string
  task:            string
  context:         string
  skills:          string[]
  priority:        number
  task_intent:     TaskIntent
  status:          'pending' | 'running' | 'completed' | 'failed'
  output?:         string
  summary?:        string
  token_count:     number
  tool_call_count: number
  error?:          string
  created_at:      Date
  completed_at?:   Date
}

export async function createSubTask(params: {
  parentTaskId:   string
  tenantId:       string
  specialistType: string
  specialistName: string
  task:           string
  context:        string
  skills:         string[]
  priority:       number
  /** Defaults to 'propose_changes' for back-compat with callers that
   *  haven't been updated yet. Orchestrator should pass explicitly. */
  taskIntent?:    TaskIntent
}): Promise<string> {
  const { v4: uuid } = await import('uuid')
  const id = uuid()
  const intent: TaskIntent = params.taskIntent ?? 'propose_changes'

  await pool.query(
    `INSERT INTO subtasks
       (id, parent_task_id, tenant_id, specialist_type, specialist_name,
        task, context, skills, priority, task_intent, status,
        token_count, tool_call_count, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',0,0,NOW())`,
    [id, params.parentTaskId, params.tenantId, params.specialistType, params.specialistName,
     params.task, params.context, JSON.stringify(params.skills), params.priority, intent]
  )

  logger.debug('subtask_created', {
    id, parentTaskId: params.parentTaskId, type: params.specialistType, intent,
  })
  return id
}

export async function startSubTask(subTaskId: string): Promise<void> {
  await pool.query(`UPDATE subtasks SET status='running' WHERE id=$1`, [subTaskId])
}

export async function completeSubTask(params: {
  subTaskId:     string
  output:        string
  summary:       string
  tokenCount:    number
  toolCallCount: number
}): Promise<void> {
  await pool.query(
    `UPDATE subtasks
     SET status='completed', output=$2, summary=$3, token_count=$4,
         tool_call_count=$5, completed_at=NOW()
     WHERE id=$1`,
    [params.subTaskId, params.output, params.summary, params.tokenCount, params.toolCallCount]
  )
}

export async function failSubTask(subTaskId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE subtasks SET status='failed', error=$2, completed_at=NOW() WHERE id=$1`,
    [subTaskId, error]
  )
}

export async function getSubTask(subTaskId: string): Promise<SubTask | null> {
  const res = await pool.query<SubTask>('SELECT * FROM subtasks WHERE id=$1', [subTaskId])
  return res.rows[0] ?? null
}

export async function getSubtasks(parentTaskId: string): Promise<SubTask[]> {
  const res = await pool.query<SubTask>(
    'SELECT * FROM subtasks WHERE parent_task_id=$1 ORDER BY priority ASC, created_at ASC',
    [parentTaskId]
  )
  return res.rows
}

export async function allSubtasksComplete(parentTaskId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT COUNT(*) as pending FROM subtasks
     WHERE parent_task_id=$1 AND status NOT IN ('completed','failed')`,
    [parentTaskId]
  )
  return parseInt(res.rows[0].pending, 10) === 0
}

export async function anySubtaskSucceeded(parentTaskId: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT COUNT(*) as done FROM subtasks WHERE parent_task_id=$1 AND status='completed'`,
    [parentTaskId]
  )
  return parseInt(res.rows[0].done, 10) > 0
}
