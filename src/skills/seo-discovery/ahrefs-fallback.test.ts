// src/skills/seo-discovery/ahrefs-fallback.test.ts
import { describe, it, expect } from 'vitest'
import { ahrefsRowsToRankingRows } from './ahrefs-fallback'

describe('ahrefsRowsToRankingRows', () => {
  it('maps Ahrefs organic keywords to RankingRow shape', () => {
    const rows = ahrefsRowsToRankingRows({
      keywords: [
        { keyword: 'Meter Box Upgrade Sydney', best_position: 12, volume: 260, best_position_url: 'https://site.au/resources/meter-box' },
      ],
    })
    expect(rows).toEqual([{
      pageUrl: 'https://site.au/resources/meter-box',
      keyword: 'meter box upgrade sydney',
      clicks: 0, impressions: 260, pos: 12,
    }])
  })

  it('drops rows without a URL and below the volume floor', () => {
    const rows = ahrefsRowsToRankingRows({
      keywords: [
        { keyword: 'no url', best_position: 5, volume: 500 },
        { keyword: 'tiny', best_position: 5, volume: 3, best_position_url: 'https://x.au/a' },
        { keyword: 'keeper', best_position: 8, volume: 50, best_position_url: 'https://x.au/b' },
      ],
    })
    expect(rows.map((r) => r.keyword)).toEqual(['keeper'])
  })

  it('is empty-safe on junk payloads', () => {
    expect(ahrefsRowsToRankingRows(null)).toEqual([])
    expect(ahrefsRowsToRankingRows({})).toEqual([])
  })
})
