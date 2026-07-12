import { describe, it, expect } from 'vitest'
import { productionUrlFor, buildDigestMarkdown, type DigestPayload } from './build'

describe('productionUrlFor', () => {
  it('builds CMS URLs from slug tools', () => {
    expect(productionUrlFor('framer_confirm_publish', { slug: 'offshore-guide' }, 'tarino.au', '/resources/'))
      .toBe('https://tarino.au/resources/offshore-guide')
  })

  it('handles domain with scheme and trailing slash', () => {
    expect(productionUrlFor('framer_update_blog_meta', { slug: 'x' }, 'https://tarino.au/', '/resources'))
      .toBe('https://tarino.au/resources/x')
  })

  it('builds marketing page URLs from pagePath', () => {
    expect(productionUrlFor('framer_update_marketing_page_text', { pagePath: 'about' }, 'tarino.au', '/resources/'))
      .toBe('https://tarino.au/about')
  })

  it('returns null without a domain or target', () => {
    expect(productionUrlFor('framer_confirm_publish', { slug: 'x' }, null, '/resources/')).toBeNull()
    expect(productionUrlFor('framer_add_site_schema', { schemaId: 'org' }, 'tarino.au', '/resources/')).toBeNull()
    expect(productionUrlFor('framer_update_blog_meta', {}, 'tarino.au', '/resources/')).toBeNull()
  })
})

describe('buildDigestMarkdown', () => {
  const base: DigestPayload = {
    tenantId: 'tarino',
    digestDate: '2026-07-12',
    actions: [
      { toolName: 'framer_update_blog_meta', proposedAction: 'Shorten the homepage title', executedAt: '2026-07-12T00:00:00Z', outcome: 'success', resolvedBy: '_autonomous_', autonomous: true, url: 'https://tarino.au/resources/x' },
      { toolName: 'manual_operator_task', proposedAction: 'Fix robots.txt', executedAt: '2026-07-12T01:00:00Z', outcome: 'success', resolvedBy: 'U123', autonomous: false, url: null },
    ],
    articles: [{ title: 'Offshore Guide', slug: 'offshore-guide', url: 'https://tarino.au/resources/offshore-guide' }],
    discards: [{ key: 'publish-failed-weak-post', value: '[Publish failed 2026-07-12] /resources/weak-post. Error: quality gate.' }],
    pendingHuman: [{ toolName: 'manual_operator_task', proposedAction: 'Add canonical to /pricing' }],
    outcomes: { wins: 2, losses: 1, neutral: 3, samples: ['[Measured outcome +14d] meta rewrite WIN.'] },
    metrics: {
      last7:  { clicks: 120, impressions: 4000, position: 8.2 },
      prior7: { clicks: 100, impressions: 3600, position: 9.1 },
      topMovers: [{ pageUrl: 'https://tarino.au/resources/x', clicksLast7: 40, clicksPrior7: 20 }],
    },
  }

  it('renders all sections with links and deltas', () => {
    const md = buildDigestMarkdown(base, 'Tarino')
    expect(md).toContain('# Daily digest — Tarino — 2026-07-12')
    expect(md).toContain('Clicks 120 (+20%)')
    expect(md).toContain('[Offshore Guide](https://tarino.au/resources/offshore-guide)')
    expect(md).toContain('[view](https://tarino.au/resources/x)')
    expect(md).toContain('(human-approved)')
    expect(md).toContain('Articles discarded by quality gate')
    expect(md).toContain('Waiting on a human (1)')
    expect(md).toContain('2 win / 1 loss / 3 neutral')
  })

  it('handles an empty day without dividing by zero', () => {
    const md = buildDigestMarkdown({
      ...base,
      actions: [], articles: [], discards: [], pendingHuman: [],
      outcomes: { wins: 0, losses: 0, neutral: 0, samples: [] },
      metrics: {
        last7:  { clicks: 0, impressions: 0, position: null },
        prior7: { clicks: 0, impressions: 0, position: null },
        topMovers: [],
      },
    }, 'Tarino')
    expect(md).toContain('None in the last 24 hours.')
    expect(md).toContain('Clicks 0 (0%)')
    expect(md).not.toContain('Articles discarded')
    expect(md).not.toContain('Waiting on a human')
  })

  it('marks new traffic as new rather than a percentage', () => {
    const md = buildDigestMarkdown({
      ...base,
      metrics: { ...base.metrics, prior7: { clicks: 0, impressions: 0, position: null } },
    }, 'Tarino')
    expect(md).toContain('Clicks 120 (new)')
  })
})
