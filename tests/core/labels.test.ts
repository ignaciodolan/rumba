import { describe, expect, it } from 'vitest'
import { baseBranch, baseBranchOf, defaultLabels, fixBranch, isValidRumbaName, stateLabel } from '../../src/core/labels.js'

describe('labels', () => {
  it('builds default names', () => {
    const l = defaultLabels('shop')
    expect(l).toEqual({ optIn: 'rumba:shop', statePrefix: 'rumba-state:', approved: 'rumba-approved', retry: 'rumba-retry' })
    expect(stateLabel(l, 'building')).toBe('rumba-state:building')
    expect(fixBranch('shop', '123')).toBe('rumba/shop/123')
    expect(baseBranch('shop', '123')).toBe('rumba/shop/base-123')
    expect(baseBranchOf('rumba/shop/ENG-12')).toBe('rumba/shop/base-ENG-12')
  })
  it('validates rumba names', () => {
    for (const ok of ['shop', 'api-v2', 'a1']) expect(isValidRumbaName(ok)).toBe(true)
    for (const bad of ['Shop', 'hub_', '-shop', 'shop-', 'a b', '']) expect(isValidRumbaName(bad)).toBe(false)
  })
})
