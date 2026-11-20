import { describe, expect, it } from 'vitest'
import { baseBranch, baseBranchOf, defaultLabels, fixBranch, isValidRumbaName, stateLabel } from '../../src/core/labels.js'

describe('labels', () => {
  it('builds default names', () => {
    const l = defaultLabels('hub')
    expect(l).toEqual({ optIn: 'rumba:hub', statePrefix: 'rumba-state:', approved: 'rumba-approved', retry: 'rumba-retry' })
    expect(stateLabel(l, 'building')).toBe('rumba-state:building')
    expect(fixBranch('hub', '123')).toBe('rumba/hub/123')
    expect(baseBranch('hub', '123')).toBe('rumba/hub/base-123')
    expect(baseBranchOf('rumba/hub/ENG-12')).toBe('rumba/hub/base-ENG-12')
  })
  it('validates rumba names', () => {
    for (const ok of ['hub', 'api-v2', 'a1']) expect(isValidRumbaName(ok)).toBe(true)
    for (const bad of ['Hub', 'hub_', '-hub', 'hub-', 'a b', '']) expect(isValidRumbaName(bad)).toBe(false)
  })
})
