// Two failures from a live run, after relocation shipped:
// 1. A relocation into `tests/connectors/notion-proposals-unsupported-blocks.test.ts` was
//    rejected as "not a test file": the name rule matched `support` inside `unsupported`.
//    Behind it, the shared fixture the checks import had moved too, which the import check
//    did not follow.
// 2. Commits were authored as the GitHub account with its noreply address, which a Vercel
//    project does not match to its owner; the clone's own git identity works.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isTestPath, judgeRelocation } from '../../src/core/relocation.js'
import { writeFile } from 'node:fs/promises'
import { makeRumba } from '../../src/testing/fakes.js'
import { buildDeps, cloneIdentity, resolveCommitAuthor } from '../../src/wiring.js'

describe('a destination named like an ordinary test', () => {
  it('is a test file, whatever words its name holds', () => {
    expect(isTestPath('tests/connectors/notion-proposals-unsupported-blocks.test.ts')).toBe(true)
    for (const ok of ['tests/services/deals.test.ts', 'tests/services/configure-pipeline.test.ts', 'tests/helpers-free/x.test.ts', 'tests/services/setupless-flow.test.ts']) expect(isTestPath(ok), ok).toBe(true)
  })

  it('still refuses files that set up, configure or help the tests', () => {
    for (const no of ['vitest.setup.ts', 'test/setupTests.ts', 'jest.config.js', 'tests/conftest.py', 'spec/spec_helper.rb', 'cypress/support/e2e.ts', 'tests/__mocks__/axios.js', 'tests/global-setup.ts']) expect(isTestPath(no), no).toBe(false)
  })
})

// A project whose tests live under tests/ (vitest `include: ['tests/**/*.test.{ts,tsx}']`),
// with `@/` imports and shared helpers in tests/helpers/.
describe('the relocation from the live run', () => {
  const FIXTURE_FROM = 'tests/rumba/proposals-fixture.ts'
  const FIXTURE_TO = 'tests/helpers/proposals-fixture.ts'
  const fixture = (db: string) => [
    `import { resetDb } from '${db}'`,
    "import { createProposal } from '@/lib/proposals'",
    '',
    'export const fakeNotion = { pages: [] as unknown[] }',
    'export async function seed() {',
    '  await resetDb()',
    "  return createProposal({ title: 'Seeded' })",
    '}',
    '',
  ].join('\n')
  const check = (fixtureModule: string, title: string) => [
    "import { describe, expect, it } from 'vitest'",
    `import { fakeNotion, seed } from '${fixtureModule}'`,
    "import { importFromNotion } from '@/lib/connectors/notion'",
    '',
    `describe('${title}', () => {`,
    "  it('skips blocks it cannot read', async () => {",
    '    await seed()',
    "    fakeNotion.pages.push({ type: 'unsupported' })",
    '    expect((await importFromNotion(fakeNotion)).skipped).toBe(1)',
    '  })',
    '})',
    '',
  ].join('\n')
  const C1_TO = 'tests/connectors/notion-proposals-import.test.ts'
  const C2_TO = 'tests/connectors/notion-proposals-unsupported-blocks.test.ts'

  function relocation() {
    return {
      original: ['c1', 'c2'].map((id) => ({ criterionId: id, command: `pnpm exec vitest run tests/rumba/${id}.test.ts`, files: [`tests/rumba/${id}.test.ts`, FIXTURE_FROM] })),
      moves: [{ from: 'tests/rumba/c1.test.ts', to: C1_TO }, { from: 'tests/rumba/c2.test.ts', to: C2_TO }, { from: FIXTURE_FROM, to: FIXTURE_TO }],
      relocated: [
        { criterionId: 'c1', command: `pnpm exec vitest run ${C1_TO}`, files: [C1_TO, FIXTURE_TO] },
        { criterionId: 'c2', command: `pnpm exec vitest run ${C2_TO}`, files: [C2_TO, FIXTURE_TO] },
      ],
      changed: ['tests/rumba/c1.test.ts', 'tests/rumba/c2.test.ts', FIXTURE_FROM, C1_TO, C2_TO, FIXTURE_TO],
      before: {
        'tests/rumba/c1.test.ts': check('./proposals-fixture', 'c1'), 'tests/rumba/c2.test.ts': check('./proposals-fixture', 'c2'),
        [FIXTURE_FROM]: fixture('../helpers/db'), [C1_TO]: null, [C2_TO]: null, [FIXTURE_TO]: null,
      },
      after: {
        'tests/rumba/c1.test.ts': null, 'tests/rumba/c2.test.ts': null, [FIXTURE_FROM]: null,
        [C1_TO]: check('../helpers/proposals-fixture', 'importing proposals from Notion'),
        [C2_TO]: check('../helpers/proposals-fixture', 'blocks Notion proposals cannot hold'),
        [FIXTURE_TO]: fixture('./db'),
      },
      protectedGlobs: [],
      changedByFix: ['tests/rumba/c1.test.ts', 'tests/rumba/c2.test.ts', FIXTURE_FROM, 'lib/connectors/notion.ts'],
    }
  }

  it('is kept: new test files, the shared fixture moved to tests/helpers, imports following it', () => {
    expect(judgeRelocation(relocation())).toBeNull()
  })

  it('still refuses a check that imports the fixture from somewhere else', () => {
    const r = relocation()
    r.after[C2_TO] = check('../helpers/other-fixture', 'blocks Notion proposals cannot hold')
    expect(judgeRelocation(r)).toMatch(/fakeNotion/)
  })

  it('follows a moved module imported with a .js extension, as TypeScript ESM writes it', () => {
    const r = relocation()
    r.before['tests/rumba/c1.test.ts'] = check('./proposals-fixture.js', 'c1')
    r.after[C1_TO] = check('../helpers/proposals-fixture.js', 'importing proposals from Notion')
    expect(judgeRelocation(r)).toBeNull()
  })
})

describe('the default commit author', () => {
  const lookup = async () => ({ login: 'octo-bot', id: 123 })
  const clone = async () => ({ name: 'Repo Owner', email: 'owner@example.test' })

  it("is the git identity of the clone Rumba runs from, when rumba.yml names none", async () => {
    expect(await resolveCommitAuthor({}, undefined, lookup, clone)).toEqual({ name: 'Repo Owner', email: 'owner@example.test' })
  })

  it('still yields to the environment variables and to rumba.yml', async () => {
    expect(await resolveCommitAuthor({ RUMBA_COMMIT_AUTHOR_NAME: 'Env', RUMBA_COMMIT_AUTHOR_EMAIL: 'env@example.test' }, undefined, lookup, clone)).toEqual({ name: 'Env', email: 'env@example.test' })
    expect(await resolveCommitAuthor({}, { name: 'Yml', email: 'yml@example.test' }, lookup, clone)).toEqual({ name: 'Yml', email: 'yml@example.test' })
  })

  it('falls back to the GitHub account, then to Rumba, when the clone has no identity or it cannot be read', async () => {
    expect(await resolveCommitAuthor({}, undefined, lookup, async () => null)).toEqual({ name: 'octo-bot', email: '123+octo-bot@users.noreply.github.com' })
    expect(await resolveCommitAuthor({}, undefined, lookup, async () => { throw new Error('git missing') })).toEqual({ name: 'octo-bot', email: '123+octo-bot@users.noreply.github.com' })
    expect(await resolveCommitAuthor({}, undefined, async () => null, async () => null)).toEqual({ name: 'Rumba', email: 'rumba@users.noreply.github.com' })
  })
})

describe('cloneIdentity', () => {
  let root: string
  // No global or system config, so only what the test sets is read.
  const isolated = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'rumba-no-such-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  const git = (...args: string[]) => execa('git', args, { cwd: root, env: isolated, stdin: 'ignore' })
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-identity-')))
    await mkdir(root, { recursive: true })
    await git('init', '-q')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it("reads the clone's user.name and user.email", async () => {
    await git('config', 'user.name', 'Repo Owner'); await git('config', 'user.email', 'owner@example.test')
    expect(await cloneIdentity(root, isolated)).toEqual({ name: 'Repo Owner', email: 'owner@example.test' })
  })

  it('reads them from the global config too, as git itself would', async () => {
    const global = path.join(root, 'global-gitconfig')
    await execa('git', ['config', '--file', global, 'user.name', 'Global Owner'])
    await execa('git', ['config', '--file', global, 'user.email', 'global@example.test'])
    expect(await cloneIdentity(root, { ...isolated, GIT_CONFIG_GLOBAL: global })).toEqual({ name: 'Global Owner', email: 'global@example.test' })
  })

  it('is null unless both are set', async () => {
    expect(await cloneIdentity(root, isolated)).toBeNull()
    await git('config', 'user.name', 'Repo Owner')
    expect(await cloneIdentity(root, isolated)).toBeNull()
  })
})

describe('the wiring', () => {
  let root: string
  beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-wired-author-'))) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it("commits as the clone's git identity when rumba.yml names no author", async () => {
    const git = (cwd: string, ...args: string[]) => execa('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdin: 'ignore' })
    const remote = path.join(root, 'remote.git'); await mkdir(remote); await git(remote, 'init', '-q', '--bare')
    await git(root, 'clone', '-q', remote, 'clone'); const clone = path.join(root, 'clone')
    // A local identity wins over any global one on the machine running the tests.
    await git(clone, 'config', 'user.name', 'Repo Owner'); await git(clone, 'config', 'user.email', 'owner@example.test')
    await writeFile(path.join(clone, 'a'), 'x'); await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'i'); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')

    const deps = buildDeps(makeRumba(), { GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a' }, { root: clone, owner: 'acme', name: 'shop', defaultBranch: 'main' })
    const { workdir } = await deps.workspace.prepare('rumba/hub/1', { fresh: true })
    await writeFile(path.join(workdir, 'b'), 'y')
    await deps.workspace.commit(workdir, 'fix: b')
    expect((await git(clone, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', 'rumba/hub/1')).stdout).toBe('Repo Owner <owner@example.test> / Repo Owner <owner@example.test>')
    await deps.workspace.cleanupAll()
  })
})
