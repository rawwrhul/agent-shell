import { describe, it, expect } from 'vitest'
import { findImageSlots, imageQueryFor, buildBylineHtml, insertAtOffsets, matchByTokenOverlap } from './content-enrich'

const html = [
  '<h2>Intro Section</h2><p>' + 'a'.repeat(300) + '</p>',
  '<h2>Defect Notices Explained</h2><p>' + 'b'.repeat(300) + '</p>',
  '<h2>Private Power Poles</h2><p>' + 'c'.repeat(300) + '</p>',
  '<h2>EV Charger Upgrades</h2><p>' + 'd'.repeat(300) + '</p>',
].join('')

describe('findImageSlots', () => {
  it('skips the first H2 and picks spaced imageless sections', () => {
    const slots = findImageSlots(html, 2)
    expect(slots.length).toBe(2)
    expect(slots[0].heading).toBe('Defect Notices Explained')
    expect(slots.every(s => s.heading !== 'Intro Section')).toBe(true)
  })

  it('skips sections that already have an image nearby', () => {
    const withImg = html.replace('<p>' + 'b'.repeat(300), '<img src="x.jpg"><p>' + 'b'.repeat(300))
    const slots = findImageSlots(withImg, 2)
    expect(slots.every(s => s.heading !== 'Defect Notices Explained')).toBe(true)
  })

  it('returns empty for single-section content', () => {
    expect(findImageSlots('<h2>Only</h2><p>x</p>', 2)).toEqual([])
  })
})

describe('imageQueryFor', () => {
  it('strips stopwords and appends context', () => {
    expect(imageQueryFor('How to Handle Defect Notices', 'electrician'))
      .toBe('handle defect notices electrician')
  })
})

describe('buildBylineHtml', () => {
  it('renders author, title, licence and date', () => {
    const b = buildBylineHtml({ name: 'Chris', title: 'Licensed Level 2 ASP', licence: '397193C', dateIso: '2026-07-14' })
    expect(b).toContain('Written by <strong>Chris</strong>')
    expect(b).toContain('Licence 397193C')
    expect(b).toContain('July')
  })
})

describe('insertAtOffsets', () => {
  it('inserts multiple fragments without shifting earlier offsets', () => {
    const out = insertAtOffsets('AABB', [{ at: 2, fragment: '-X-' }, { at: 4, fragment: '-Y-' }])
    expect(out).toBe('AA-X-BB-Y-')
  })
})

describe('matchByTokenOverlap', () => {
  const services = [
    { id: 's1', name: 'Switchboard Upgrades' },
    { id: 's2', name: 'EV Charger Installation' },
    { id: 's3', name: 'Defect Notice Rectification' },
    { id: 's4', name: 'Pool Bonding & RCD Protection' },
  ]

  it('picks relevant refs by name overlap', () => {
    const picks = matchByTokenOverlap('Level 2 ASP guide: defect notices, EV charger upgrades and consumer mains', services, 3)
    expect(picks).toContain('s2')
    expect(picks).toContain('s3')
    expect(picks).not.toContain('s4')
  })

  it('returns empty when nothing overlaps', () => {
    expect(matchByTokenOverlap('offshore accounting teams', services, 3)).toEqual([])
  })
})
