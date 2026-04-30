import fs   from 'fs'
import path from 'path'
import { config } from '../config'
import { ProgressFile, FeatureItem } from '../types'
import { logger } from '../logger'

function pPath(taskId: string): string {
  const dir = path.resolve(config.PROGRESS_DIR)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${taskId}.json`)
}

export const progressExists = (taskId: string) => fs.existsSync(pPath(taskId))

export function readProgress(taskId: string): ProgressFile | null {
  const p = pPath(taskId)
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

export function writeProgress(progress: ProgressFile) {
  progress.updatedAt = new Date().toISOString()
  fs.writeFileSync(pPath(progress.taskId), JSON.stringify(progress, null, 2), 'utf-8')
  logger.debug('progress_written', { taskId: progress.taskId })
}

export function initProgress(params: { taskId: string; agentType: string; features: FeatureItem[] }): ProgressFile {
  const p: ProgressFile = {
    taskId:        params.taskId,
    agentType:     params.agentType,
    createdAt:     new Date().toISOString(),
    updatedAt:     new Date().toISOString(),
    sessionCount:  0,
    features:      params.features,
    recentSummary: 'Environment initialised. No sessions completed yet.',
    nextPriority:  'Run init.sh to verify environment, then begin the first failing feature.',
    gitCommits:    [],
  }
  writeProgress(p)
  return p
}

export function recordSession(taskId: string, summary: string, nextPriority: string, commitSha?: string) {
  const p = readProgress(taskId)
  if (!p) return
  p.sessionCount++
  p.recentSummary = summary
  p.nextPriority  = nextPriority
  if (commitSha) p.gitCommits.push(commitSha)
  writeProgress(p)
}

export function markFeaturePassing(taskId: string, featureId: string, notes?: string) {
  const p = readProgress(taskId)
  if (!p) return
  const f = p.features.find(x => x.id === featureId)
  if (f) { f.passes = true; f.completedAt = new Date().toISOString(); if (notes) f.notes = notes }
  writeProgress(p)
}

export function getContextSummary(taskId: string): string {
  const p = readProgress(taskId)
  if (!p) return 'No progress file found — you may be starting fresh.'
  const passing = p.features.filter(f => f.passes).length
  const next    = p.features.find(f => !f.passes)
  return [
    `## Task progress (session ${p.sessionCount + 1})`,
    `Last session: ${p.recentSummary}`,
    `Completion: ${passing}/${p.features.length} features passing`,
    `Your priority this session: ${p.nextPriority}`,
    next ? `Next failing feature: [${next.id}] ${next.description}` : `All features passing — verify end-to-end and write final summary.`,
  ].join('\n')
}
