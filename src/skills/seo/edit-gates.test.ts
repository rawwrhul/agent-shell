import { describe, it, expect } from 'vitest'
import { inputBoundErrors, targetPathOf, EDIT_GATE_TOOLS } from './edit-gates'

describe('inputBoundErrors', () => {
  it('rejects out-of-range titles and descriptions', () => {
    const errs = inputBoundErrors('framer_update_blog_meta', {
      newTitle: 'Too short',
      newDescription: 'Also way too short.',
    })
    expect(errs).toHaveLength(2)
    expect(errs[0]).toContain('newTitle')
    expect(errs[1]).toContain('newDescription')
  })

  it('accepts in-range meta', () => {
    const errs = inputBoundErrors('framer_update_blog_meta', {
      newTitle: 'Offshore Accounting Teams: Costs, Process, Risks',
      newDescription: 'What offshore accounting actually costs in 2026, how the engagement works month to month, and the risks to price in before you sign.',
    })
    expect(errs).toHaveLength(0)
  })

  it('skips checks for fields not being changed', () => {
    expect(inputBoundErrors('framer_update_blog_meta', { newDescription: '' })).toHaveLength(0)
  })

  it('rejects generic anchor text on internal links', () => {
    const errs = inputBoundErrors('framer_add_internal_link', { sourceText: 'Click Here' })
    expect(errs).toHaveLength(1)
    expect(inputBoundErrors('framer_add_internal_link', { sourceText: 'offshore payroll guide' })).toHaveLength(0)
  })
})

describe('targetPathOf', () => {
  it('resolves slug tools to CMS paths', () => {
    expect(targetPathOf('framer_update_blog_meta', { slug: 'my-post' }, '/resources/')).toBe('/resources/my-post')
  })

  it('resolves marketing page paths', () => {
    expect(targetPathOf('framer_update_marketing_page_text', { pagePath: 'about' }, '/resources/')).toBe('/about')
  })

  it('returns null when no target is derivable', () => {
    expect(targetPathOf('framer_update_blog_meta', {}, '/resources/')).toBeNull()
  })
})

describe('EDIT_GATE_TOOLS', () => {
  it('covers the write tools without executors excluded', () => {
    expect(EDIT_GATE_TOOLS.has('framer_update_blog_meta')).toBe(true)
    expect(EDIT_GATE_TOOLS.has('framer_add_internal_link')).toBe(true)
    expect(EDIT_GATE_TOOLS.has('approve_blog_pitch')).toBe(false)
    expect(EDIT_GATE_TOOLS.has('manual_operator_task')).toBe(false)
  })
})
