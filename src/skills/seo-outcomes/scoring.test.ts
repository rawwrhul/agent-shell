import { describe, it, expect } from 'vitest'
import { scoreOutcome, type WindowMetrics } from './scoring'
import { targetPathFor } from './index'

const m = (clicks: number, impressions: number, position: number | null): WindowMetrics =>
  ({ clicks, impressions, position })

describe('scoreOutcome — existing pages', () => {
  it('win: page clicks outpace the site control', () => {
    const r = scoreOutcome({
      pageBefore: m(20, 500, 8), pageAfter: m(35, 600, 6),
      controlBefore: m(1000, 20000, null), controlAfter: m(1050, 21000, null),
      isNewPage: false,
    })
    expect(r.verdict).toBe('win')
    expect(r.liftPct).toBeGreaterThanOrEqual(25)
  })

  it('neutral: page rose exactly with the site (seasonality, not the action)', () => {
    const r = scoreOutcome({
      pageBefore: m(20, 500, 8), pageAfter: m(24, 550, 7.9),
      controlBefore: m(1000, 20000, null), controlAfter: m(1200, 24000, null),
      isNewPage: false,
    })
    expect(r.verdict).toBe('neutral')
  })

  it('loss: page fell while the site held', () => {
    const r = scoreOutcome({
      pageBefore: m(30, 800, 5), pageAfter: m(15, 700, 5.1),
      controlBefore: m(1000, 20000, null), controlAfter: m(1000, 20000, null),
      isNewPage: false,
    })
    expect(r.verdict).toBe('loss')
  })

  it('falls back to position when click volume is too low', () => {
    const win = scoreOutcome({
      pageBefore: m(1, 300, 12), pageAfter: m(3, 400, 7),
      controlBefore: m(500, 9000, null), controlAfter: m(500, 9000, null),
      isNewPage: false,
    })
    expect(win.verdict).toBe('win')

    const loss = scoreOutcome({
      pageBefore: m(2, 300, 6), pageAfter: m(1, 250, 11),
      controlBefore: m(500, 9000, null), controlAfter: m(500, 9000, null),
      isNewPage: false,
    })
    expect(loss.verdict).toBe('loss')
  })

  it('neutral when there is no usable signal at all', () => {
    const r = scoreOutcome({
      pageBefore: m(0, 0, null), pageAfter: m(1, 5, null),
      controlBefore: m(500, 9000, null), controlAfter: m(510, 9100, null),
      isNewPage: false,
    })
    expect(r.verdict).toBe('neutral')
  })
})

describe('scoreOutcome — new pages', () => {
  it('win on clicks', () => {
    const r = scoreOutcome({
      pageBefore: m(0, 0, null), pageAfter: m(8, 150, 14),
      controlBefore: m(500, 9000, null), controlAfter: m(500, 9000, null),
      isNewPage: true,
    })
    expect(r.verdict).toBe('win')
  })

  it('win on visibility even before clicks arrive', () => {
    const r = scoreOutcome({
      pageBefore: m(0, 0, null), pageAfter: m(1, 350, 18),
      controlBefore: m(500, 9000, null), controlAfter: m(500, 9000, null),
      isNewPage: true,
    })
    expect(r.verdict).toBe('win')
  })

  it('loss when near-invisible after the window', () => {
    const r = scoreOutcome({
      pageBefore: m(0, 0, null), pageAfter: m(0, 4, null),
      controlBefore: m(500, 9000, null), controlAfter: m(500, 9000, null),
      isNewPage: true,
    })
    expect(r.verdict).toBe('loss')
  })

  it('neutral in the ramping middle', () => {
    const r = scoreOutcome({
      pageBefore: m(0, 0, null), pageAfter: m(2, 80, 22),
      controlBefore: m(500, 9000, null), controlAfter: m(500, 9000, null),
      isNewPage: true,
    })
    expect(r.verdict).toBe('neutral')
  })
})

describe('targetPathFor', () => {
  it('builds CMS paths from slug tools', () => {
    expect(targetPathFor('framer_update_blog_meta', { slug: 'best-offshore-teams' }, '/resources/'))
      .toBe('/resources/best-offshore-teams')
    expect(targetPathFor('approve_blog_pitch', { slug: '/trimmed/' }, '/resources'))
      .toBe('/resources/trimmed')
  })

  it('uses pagePath for marketing page edits', () => {
    expect(targetPathFor('framer_update_marketing_page_text', { pagePath: '/about' }, '/resources/'))
      .toBe('/about')
    expect(targetPathFor('framer_update_marketing_page_text', { pagePath: 'pricing' }, '/resources/'))
      .toBe('/pricing')
  })

  it('returns null for site-wide or untargetable tools', () => {
    expect(targetPathFor('framer_add_site_schema', { schemaId: 'org' }, '/resources/')).toBeNull()
    expect(targetPathFor('gsc_submit_sitemap', {}, '/resources/')).toBeNull()
    expect(targetPathFor('framer_update_blog_meta', {}, '/resources/')).toBeNull()
    expect(targetPathFor('framer_update_marketing_page_text', { pagePath: '/' }, '/resources/')).toBeNull()
  })
})
