import fs   from 'fs'
import path from 'path'
import { config } from '../config'
import { logger } from '../logger'

export interface SkillMeta {
  name:        string
  description: string
  triggers:    string[]
  contentPath: string
}

let registry: SkillMeta[] | null = null

export function loadSkillRegistry(): SkillMeta[] {
  if (registry) return registry
  const dir = path.resolve(config.SKILLS_DIR)
  if (!fs.existsSync(dir)) { logger.warn('skills_dir_not_found', { dir }); return [] }

  const skills: SkillMeta[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const mdPath = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(mdPath)) continue
    const meta = parseFrontmatter(fs.readFileSync(mdPath, 'utf-8'))
    if (!meta.name || !meta.description) { logger.warn('skill_missing_metadata', { dir: entry.name }); continue }
    skills.push({ name: meta.name as string, description: meta.description as string, triggers: (meta.triggers as string[]) ?? [], contentPath: mdPath })
  }

  registry = skills
  logger.info('skills_loaded', { count: skills.length })
  return skills
}

/** Build the lightweight skill index for a tenant's agent system prompt */
export function buildTenantSkillsPrompt(allowedSkills: string[]): string {
  const all   = loadSkillRegistry()
  const skills = allowedSkills.length ? all.filter(s => allowedSkills.includes(s.name)) : all
  if (!skills.length) return ''

  const lines = ['## Available skills', '']
  for (const s of skills) {
    lines.push(`### ${s.name}`)
    lines.push(s.description)
    if (s.triggers.length) lines.push(`Use when: ${s.triggers.join(', ')}`)
    lines.push(`To load: use the read_file tool on path: ${s.contentPath}`)
    lines.push('')
  }
  lines.push('Only load skills relevant to your current task. Do not front-load all skills.')
  return lines.join('\n')
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m) return {}
  const out: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const k = line.slice(0, colon).trim()
    const v = line.slice(colon + 1).trim()
    out[k] = v.startsWith('[') && v.endsWith(']')
      ? v.slice(1,-1).split(',').map(x => x.trim().replace(/^["']|["']$/g,''))
      : v.replace(/^["']|["']$/g,'')
  }
  return out
}
