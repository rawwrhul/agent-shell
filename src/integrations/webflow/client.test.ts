import { describe, it, expect } from 'vitest'
import { productionUrl, blogPath } from './client'
import { isWebflowToolName } from './tools'
import type { TenantConfig } from '../../tenants/types'

const tenant = {
  targetDomain: 'https://www.hdlevel2electriciansydney.com.au/',
  cmsPathPrefixes: ['/resources/'],
} as unknown as TenantConfig

describe('webflow url helpers', () => {
  it('builds production URLs from a schemeful domain with trailing slash', () => {
    expect(productionUrl(tenant, '/resources/switchboard-guide'))
      .toBe('https://www.hdlevel2electriciansydney.com.au/resources/switchboard-guide')
  })

  it('builds blog paths from the tenant prefix', () => {
    expect(blogPath(tenant, '/ev-charger-costs/')).toBe('/resources/ev-charger-costs')
    expect(blogPath({ ...tenant, cmsPathPrefixes: undefined } as unknown as TenantConfig, 'x'))
      .toBe('/resources/x')
  })
})

describe('isWebflowToolName', () => {
  it('matches read tools, not the executor names routed via dispatch', () => {
    expect(isWebflowToolName('webflow_list_blog_items')).toBe(true)
    expect(isWebflowToolName('webflow_get_site_info')).toBe(true)
    expect(isWebflowToolName('webflow_confirm_publish')).toBe(false)
    expect(isWebflowToolName('framer_list_blog_items')).toBe(false)
  })
})
