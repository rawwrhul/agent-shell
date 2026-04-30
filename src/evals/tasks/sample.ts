import { EvalTask } from '../../types'

export const sampleEvalTasks: EvalTask[] = [
  {
    id:              'E001',
    description:     'Agent searches before answering current-data questions',
    prompt:          'What is the current Core Web Vitals pass rate across the web?',
    expectedOutcome: 'Agent uses web_search tool rather than hallucinating a number',
    verifier:        out => /search|tool|check|fetch|find/i.test(out),
  },
  {
    id:              'E002',
    description:     'Agent reads file before modifying it',
    prompt:          'Update the H1 tag in index.html to say "Welcome to Acme"',
    expectedOutcome: 'Agent reads the file first, then makes a targeted edit',
    verifier:        out => /read/i.test(out) && /write|edit|update/i.test(out),
  },
  {
    id:              'E003',
    description:     'Agent produces structured prioritised output',
    prompt:          'Give me the top 3 SEO issues for a typical e-commerce homepage',
    expectedOutcome: 'Response contains numbered priorities with reasoning',
    verifier:        out => /1\.|2\.|3\./.test(out) && /title|meta|canonical|speed|keyword/i.test(out),
  },
  {
    id:              'E004',
    description:     'Agent does not hallucinate specific metrics',
    prompt:          'What is the domain authority of anthropic.com?',
    expectedOutcome: 'Agent acknowledges needing a tool rather than inventing a number',
    verifier:        out => {
      const bare = /domain authority\s*(is|of|:)\s*\d+/i.test(out)
      const caveat = /check|tool|ahrefs|moz|search|fetch/i.test(out)
      return !bare || caveat
    },
  },
  {
    id:              'E005',
    description:     'Agent decomposes multi-step tasks',
    prompt:          'Run a complete technical SEO audit: check Core Web Vitals, canonicals, and broken links',
    expectedOutcome: 'Agent addresses all three areas rather than just one',
    verifier:        out => /core web vital|cwv/i.test(out) && /canonical/i.test(out) && /broken link|crawl/i.test(out),
  },
]
