const fs = require('fs')
const path = require('path')

const patches = [
  {
    file: 'src/agents/tools.ts',
    label: 'webSearch: total-budget timeout + graceful error returns',
    sentinel: 'web_search body timeout',
    edits: [
      {
        old: `async function webSearch(query: string, maxResults: number): Promise<string> {
  // Uses Anthropic's web search via the API — simple implementation
  // For production, wire in a dedicated search API (Serper, Brave, etc.)
  try {
    const res = await fetch(
      \`https://api.search.brave.com/res/v1/web/search?q=\${encodeURIComponent(query)}&count=\${maxResults}\`,
      { headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip' } }
    )
    if (!res.ok) return \`Search failed: \${res.status}. Configure BRAVE_API_KEY for web search.\`
    const data = await res.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } }
    const results = data?.web?.results ?? []
    return results.map((r, i) => \`\${i+1}. \${r.title}\\n   \${r.url}\\n   \${r.description}\`).join('\\n\\n') || 'No results found'
  } catch {
    return 'Web search unavailable — add BRAVE_API_KEY to environment or wire in a search provider'
  }
}`,
        new: `async function webSearch(query: string, maxResults: number): Promise<string> {
  // Two-layer timeout — same pattern as webFetch. AbortSignal on fetch()
  // covers network handshake, Promise.race covers res.json() body read
  // in case the server stalls mid-stream.
  const controller   = new AbortController()
  const networkTimer = setTimeout(() => controller.abort(), 15_000)

  let res: Response
  try {
    res = await fetch(
      \`https://api.search.brave.com/res/v1/web/search?q=\${encodeURIComponent(query)}&count=\${maxResults}\`,
      {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip' },
        signal:  controller.signal,
      }
    )
  } catch (err: any) {
    clearTimeout(networkTimer)
    return \`[web_search network error: \${String(err?.message ?? err).slice(0, 200)}]\`
  }

  if (!res.ok) {
    clearTimeout(networkTimer)
    return \`Search failed: HTTP \${res.status}. Configure BRAVE_API_KEY for web search.\`
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
    return \`[web_search body timeout after 15s for query: \${query.slice(0, 80)}]\`
  }
  clearTimeout(networkTimer)

  const results = data?.web?.results ?? []
  return results.map((r: any, i: number) => \`\${i+1}. \${r.title}\\n   \${r.url}\\n   \${r.description}\`).join('\\n\\n') || 'No results found'
}`,
      },
    ],
  },
]

let allDone = true
for (const p of patches) {
  const abs = path.resolve(process.cwd(), p.file)
  if (!fs.existsSync(abs)) { console.error('NOT FOUND:', p.file); process.exit(1) }
  const src = fs.readFileSync(abs, 'utf8')
  if (src.includes(p.sentinel)) {
    console.log('• ' + p.label + ': already patched')
    continue
  }
  allDone = false
  let next = src
  for (const e of p.edits) {
    if (!next.includes(e.old)) {
      console.error('ANCHOR NOT FOUND in ' + p.file)
      console.error('  Expected (first 200 chars):')
      console.error('  ' + e.old.slice(0, 200).replace(/\n/g, '\n  '))
      process.exit(1)
    }
    next = next.replace(e.old, e.new)
  }
  fs.writeFileSync(abs, next)
  console.log('✓ Patched ' + p.file)
}

if (allDone) console.log('patch already applied')
else console.log('done')
