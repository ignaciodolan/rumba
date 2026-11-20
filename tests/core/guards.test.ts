import { describe, expect, it } from 'vitest'
import { changedChecks, outsideScope, protectedViolations } from '../../src/core/guards.js'

describe('guards', () => {
  it('flags .rumba and configured globs', () => {
    expect(protectedViolations(['src/a.ts', '.rumba/hub/context.md', 'docker-compose.yml'], ['docker-compose*.y*ml']))
      .toEqual(['.rumba/hub/context.md', 'docker-compose.yml'])
  })
  it('reports changed and deleted check files', () => {
    expect(changedChecks({ a: '1', b: '2' }, { a: '1', b: '3' })).toEqual(['b'])
    expect(changedChecks({ a: '1' }, {})).toEqual(['a'])
  })
  it('lists files outside scope, ignoring check files', () => {
    expect(outsideScope(['apps/hub/x.ts', 'packages/ui/y.ts', 'tests/rumba/c1.test.ts'], ['apps/hub/**'], ['tests/rumba/c1.test.ts'])).toEqual(['packages/ui/y.ts'])
    expect(outsideScope(['anything.ts'], [], [])).toEqual([])
  })
})
