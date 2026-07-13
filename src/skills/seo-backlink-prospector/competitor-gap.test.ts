import { describe, it, expect } from 'vitest'
import { mapAhrefsBacklinkRows } from './competitor-gap'

describe('mapAhrefsBacklinkRows', () => {
  it('maps canonical Ahrefs v3 field names', () => {
    const rows = mapAhrefsBacklinkRows({
      backlinks: [{
        url_from: 'https://www.example.com/blog/post',
        domain_rating_source: 71,
        anchor: 'offshore teams guide',
        is_dofollow: true,
        url_to: 'https://competitor.au/resource',
      }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      source_url:    'https://www.example.com/blog/post',
      source_domain: 'example.com',
      source_rank:   71,
      anchor:        'offshore teams guide',
      dofollow:      true,
      target_url:    'https://competitor.au/resource',
    })
  })

  it('tolerates alternate envelope and field names', () => {
    const rows = mapAhrefsBacklinkRows({
      items: [{
        source_url: 'https://blog.example.org/x',
        dr: '55',
        is_nofollow: true,
      }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].source_domain).toBe('blog.example.org')
    expect(rows[0].source_rank).toBe(55)
    expect(rows[0].dofollow).toBe(false)
  })

  it('drops rows without a usable source URL', () => {
    expect(mapAhrefsBacklinkRows({ backlinks: [{ anchor: 'x' }] })).toHaveLength(0)
  })

  it('returns empty for unrecognizable shapes (caller falls back to DataForSEO)', () => {
    expect(mapAhrefsBacklinkRows(null)).toHaveLength(0)
    expect(mapAhrefsBacklinkRows({ error: 'unauthorized' })).toHaveLength(0)
    expect(mapAhrefsBacklinkRows('nope')).toHaveLength(0)
  })
})
