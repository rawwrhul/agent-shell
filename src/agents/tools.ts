import fs             from 'fs'
import path           from 'path'
import { exec }       from 'child_process'
import { promisify }  from 'util'
import Anthropic       from '@anthropic-ai/sdk'

const execAsync = promisify(exec)

// ── Tool definitions (passed to Claude API) ───────────────────────────────────

export const AGENT_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Use for reading progress files, skill files, configs, and any text content.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Absolute or relative file path to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file and any parent directories if they do not exist.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path:    { type: 'string', description: 'File path to write to' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and subdirectories in a directory.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Directory path to list' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command. High-risk commands require human approval. Use for git operations, running scripts, checking environment, calling CLIs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd:     { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information. Use for research, competitor analysis, finding documentation, checking facts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query:      { type: 'string', description: 'Search query (3-8 words, specific)' },
        max_results: { type: 'number', description: 'Maximum results to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch the content of a specific URL. Use to read web pages, APIs, documentation, or any URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full URL to fetch including https://' },
      },
      required: ['url'],
    },
  },
]

// ── Tool execution engine ─────────────────────────────────────────────────────

export async function executeTool(name: string, input: Record<string, unknown>, workDir: string): Promise<string> {
  try {
    switch (name) {
      case 'read_file':        return await readFile(String(input.path))
      case 'write_file':       return await writeFile(String(input.path), String(input.content))
      case 'list_directory':   return await listDirectory(String(input.path))
      case 'run_command':      return await runCommand(String(input.command), String(input.cwd ?? workDir))
      case 'web_search':       return await webSearch(String(input.query), Number(input.max_results ?? 5))
      case 'web_fetch':        return await webFetch(String(input.url))
      default:                 return `Unknown tool: ${name}`
    }
  } catch (err) {
    return `Error executing ${name}: ${String(err)}`
  }
}

// ── Individual tool implementations ──────────────────────────────────────────

async function readFile(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath)
  if (!fs.existsSync(resolved)) return `File not found: ${resolved}`
  const content = fs.readFileSync(resolved, 'utf-8')
  // Cap at 50k chars to avoid flooding the context window
  return content.length > 50000
    ? content.slice(0, 50000) + `\n\n[Truncated — file is ${content.length} chars, showing first 50000]`
    : content
}

async function writeFile(filePath: string, content: string): Promise<string> {
  const resolved = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')
  return `Written ${content.length} chars to ${resolved}`
}

async function listDirectory(dirPath: string): Promise<string> {
  const resolved = path.resolve(dirPath)
  if (!fs.existsSync(resolved)) return `Directory not found: ${resolved}`
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const lines = entries.map(e => `${e.isDirectory() ? 'd' : 'f'}  ${e.name}`)
  return lines.join('\n') || '(empty directory)'
}

async function runCommand(command: string, cwd: string): Promise<string> {
  const { stdout, stderr } = await execAsync(command, { cwd, timeout: 60_000 })
  const out = [stdout, stderr].filter(Boolean).join('\n').trim()
  return out || '(command completed with no output)'
}

async function webSearch(query: string, maxResults: number): Promise<string> {
  // Two-layer timeout — same pattern as webFetch. AbortSignal on fetch()
  // covers network handshake, Promise.race covers res.json() body read
  // in case the server stalls mid-stream.
  const controller   = new AbortController()
  const networkTimer = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
        signal:  controller.signal,
      }
    )
  } catch (err: any) {
    clearTimeout(networkTimer)
    return `[web_search network error: ${String(err?.message ?? err).slice(0, 200)}]`
  }

  if (!res.ok) {
    clearTimeout(networkTimer)
    return `Search failed: HTTP ${res.status}. Configure BRAVE_API_KEY for web search.`
  }

  let data: any
  try {
    data = await Promise.race([
      res.json(),
      new Promise<never>((_, reject) => setTimeout(() => {
        controller.abort()
        reject(new Error('body_read_timeout'))
      }, 15_000)),
    ])
  } catch {
    clearTimeout(networkTimer)
    return `[web_search body timeout after 15s for query: ${query.slice(0, 80)}]`
  }
  clearTimeout(networkTimer)

  const results = data?.web?.results ?? []
  return results.map((r: any, i: number) => `${i+1}. ${r.title}\n   ${r.url}\n   ${r.description}`).join('\n\n') || 'No results found'
}

async function webFetch(url: string): Promise<string> {
  // Two-layer timeout. AbortSignal in fetch() covers the network handshake,
  // but in some Node versions it doesn't reliably propagate into res.text()
  // for chunked-encoding/keep-alive responses that never close. The outer
  // Promise.race is the belt-and-braces guard.
  const controller    = new AbortController()
  const networkTimer  = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'CGS-Agent/2.0' },
      signal:  controller.signal,
    })
  } catch (err: any) {
    clearTimeout(networkTimer)
    return `[web_fetch network error for ${url}: ${String(err?.message ?? err).slice(0, 200)}]`
  }

  if (!res.ok) {
    clearTimeout(networkTimer)
    return `[web_fetch HTTP ${res.status} for ${url}]`
  }

  let text: string
  try {
    text = await Promise.race([
      res.text(),
      new Promise<string>((_, reject) => setTimeout(() => {
        controller.abort()
        reject(new Error('body_read_timeout'))
      }, 30_000)),
    ])
  } catch {
    clearTimeout(networkTimer)
    return `[web_fetch body timeout after 30s for ${url}]`
  }
  clearTimeout(networkTimer)

  // Strip HTML tags for cleaner context
  const clean = text.replace(/<script[\s\S]*?<\/script>/gi, '')
                    .replace(/<style[\s\S]*?<\/style>/gi, '')
                    .replace(/<[^>]+>/g, ' ')
                    .replace(/\s{2,}/g, ' ')
                    .trim()
  return clean.length > 40000 ? clean.slice(0, 40000) + '\n[Truncated]' : clean
}
