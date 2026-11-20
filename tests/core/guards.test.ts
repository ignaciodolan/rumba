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
  it('matches slashless globs by name at any depth', () => {
    expect(protectedViolations(['apps/hub/docker-compose.yml', 'apps/hub/src/a.ts'], ['docker-compose*.y*ml']))
      .toEqual(['apps/hub/docker-compose.yml'])
  })
  it('keeps globs with a slash anchored to the full path', () => {
    expect(protectedViolations(['infra/main.tf', 'apps/infra/main.tf'], ['infra/*.tf'])).toEqual(['infra/main.tf'])
  })
  it('matches protected paths case-insensitively', () => {
    expect(protectedViolations(['.Rumba/hub/context.md', 'Docker-Compose.yml'], ['docker-compose*.y*ml']))
      .toEqual(['.Rumba/hub/context.md', 'Docker-Compose.yml'])
  })
})
