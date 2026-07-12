import { describe, it, expect } from 'vitest'
import { isAutoExecutable, isFullyAutonomous } from './autonomy'

describe('isFullyAutonomous', () => {
  it('true only at autonomy_level=full', () => {
    expect(isFullyAutonomous({ autonomyLevel: 'full' })).toBe(true)
  })

  it('false for hitl, undefined, and missing tenant', () => {
    expect(isFullyAutonomous({ autonomyLevel: 'hitl' })).toBe(false)
    expect(isFullyAutonomous({ autonomyLevel: undefined })).toBe(false)
    expect(isFullyAutonomous(null)).toBe(false)
    expect(isFullyAutonomous(undefined)).toBe(false)
  })
})

describe('isAutoExecutable', () => {
  it('allows registered API executors', () => {
    expect(isAutoExecutable('framer_update_blog_meta')).toBe(true)
    expect(isAutoExecutable('framer_add_internal_link')).toBe(true)
    expect(isAutoExecutable('approve_blog_pitch')).toBe(true)
    expect(isAutoExecutable('framer_confirm_publish')).toBe(true)
    expect(isAutoExecutable('gsc_submit_sitemap')).toBe(true)
  })

  it('denies human-performed tools even though they have handlers', () => {
    expect(isAutoExecutable('manual_operator_task')).toBe(false)
    expect(isAutoExecutable('outreach_send_mailto')).toBe(false)
  })

  it('denies tools without a registered executor', () => {
    expect(isAutoExecutable('made_up_tool')).toBe(false)
  })
})
