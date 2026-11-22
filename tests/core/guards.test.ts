import { DEFAULT_DOCKER_PROTECTED } from '../../src/config/schema.js'
import { describe, expect, it } from 'vitest'
import { changedChecks, outsideScope, protectedViolations } from '../../src/core/guards.js'

describe('guards', () => {
  it('flags .rumba and configured globs', () => {
    expect(protectedViolations(['src/a.ts', '.rumba/shop/context.md', 'docker-compose.yml'], ['docker-compose*.y*ml']))
      .toEqual(['.rumba/shop/context.md', 'docker-compose.yml'])
  })
  it('reports changed and deleted check files', () => {
    expect(changedChecks({ a: '1', b: '2' }, { a: '1', b: '3' })).toEqual(['b'])
    expect(changedChecks({ a: '1' }, {})).toEqual(['a'])
  })
  it('protects, by default for docker, the files that define the containers', () => {
  const changed = ['docker-compose.yml', 'apps/shop/compose.override.yaml', 'Dockerfile', 'apps/shop/Dockerfile.dev', 'docker/api.dockerfile', '.dockerignore', 'src/docker.ts', 'docs/docker.md']
  expect(protectedViolations(changed, DEFAULT_DOCKER_PROTECTED))
    .toEqual(['docker-compose.yml', 'apps/shop/compose.override.yaml', 'Dockerfile', 'apps/shop/Dockerfile.dev', 'docker/api.dockerfile', '.dockerignore'])
})
it('lists files outside scope, ignoring check files', () => {
    expect(outsideScope(['apps/shop/x.ts', 'packages/ui/y.ts', 'tests/rumba/c1.test.ts'], ['apps/shop/**'], ['tests/rumba/c1.test.ts'])).toEqual(['packages/ui/y.ts'])
    expect(outsideScope(['anything.ts'], [], [])).toEqual([])
  })
  it('matches slashless globs by name at any depth', () => {
    expect(protectedViolations(['apps/shop/docker-compose.yml', 'apps/shop/src/a.ts'], ['docker-compose*.y*ml']))
      .toEqual(['apps/shop/docker-compose.yml'])
  })
  it('keeps globs with a slash anchored to the full path', () => {
    expect(protectedViolations(['infra/main.tf', 'apps/infra/main.tf'], ['infra/*.tf'])).toEqual(['infra/main.tf'])
  })
  it('matches protected paths case-insensitively', () => {
    expect(protectedViolations(['.Rumba/shop/context.md', 'Docker-Compose.yml'], ['docker-compose*.y*ml']))
      .toEqual(['.Rumba/shop/context.md', 'Docker-Compose.yml'])
  })
  it('always protects .github/** with no protected globs configured', () => {
    expect(protectedViolations(['.github/workflows/ci.yml', '.github/CODEOWNERS', 'src/github.ts', 'docs/.github/x'], []))
      .toEqual(['.github/workflows/ci.yml', '.github/CODEOWNERS'])
  })
  it('always protects a file named .env at any depth, and only that name', () => {
    expect(protectedViolations(['.env', 'apps/shop/.env', 'src/.ENV', '.env.example', 'src/env.ts'], []))
      .toEqual(['.env', 'apps/shop/.env', 'src/.ENV'])
  })
})
