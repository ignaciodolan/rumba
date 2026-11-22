// Check relocation: the config switch, the agent task and its result, and the two git
// primitives the step needs. The step itself is in tests/core/steps/relocateChecks.test.ts
// and the line check in tests/core/relocation.test.ts.
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESULT_PATH, buildPrompt } from '../../src/adapters/agent/prompts.js'
import { readAgentResult } from '../../src/adapters/agent/result.js'
import { GitWorkspace } from '../../src/adapters/workspace/git.js'
import { loadRumba } from '../../src/config/load.js'
import { makeTicket } from '../../src/testing/fakes.js'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-relocation-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(dir: string, rel: string, content: string): Promise<void> {
  const file = path.join(dir, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

describe('checks.relocate in rumba.yml', () => {
  const minimal = 'paths: []\ntracker: { kind: github }\nagent: { kind: claude-code }\nenvironment: { kind: docker, up: "u", exec: "e", down: "d" }\n'

  it('is on by default', async () => {
    await write(root, '.rumba/shop/rumba.yml', minimal)
    expect((await loadRumba(root, 'shop')).checks).toEqual({ relocate: true })
  })

  it('can be turned off, and must be a boolean', async () => {
    await write(root, '.rumba/shop/rumba.yml', `${minimal}checks: { relocate: false }\n`)
    expect((await loadRumba(root, 'shop')).checks).toEqual({ relocate: false })
    await write(root, '.rumba/shop/rumba.yml', `${minimal}checks: { relocate: "no" }\n`)
    await expect(loadRumba(root, 'shop')).rejects.toThrow(/checks\.relocate/)
  })
})

describe('the relocate-checks task', () => {
  const task = {
    kind: 'relocate-checks' as const, ticket: makeTicket(), context: '', environmentKind: 'docker' as const, execPrefix: 'docker compose exec -T app',
    criteria: [{ id: 'c1', text: 'Saving returns 200', checkable: true }],
    checks: [{ criterionId: 'c1', command: 'npx vitest run tests/rumba/c1.test.ts', files: ['tests/rumba/c1.test.ts'] }],
  }

  it("tells the agent to move the checks into the project's tests without changing what they assert", () => {
    const p = buildPrompt(task)
    expect(p).toContain("Move Rumba's checks into the project's own tests")
    expect(p).toContain('tests/rumba/c1.test.ts')
    expect(p).toMatch(/merge/i)
    expect(p).toMatch(/Keep every line of a check exactly as it is/)
    expect(p).toMatch(/how the imports are written[\s\S]*the test titles/)
    expect(p).toMatch(/the end of an existing test file, after everything already there, as one block/)
    expect(p).toMatch(/no hooks or mocks/)
    expect(p).toMatch(/never a file that sets up or configures the tests/)
    expect(p).toMatch(/on the base commit, where it must fail/)
    expect(p).toMatch(/the command above, with only the file path changed/)
    expect(p).toContain('docker compose exec -T app')
    expect(p).toContain('"kind": "relocate-checks"')
    expect(p).toContain('"moves"')
  })

  describe('its result', () => {
    let dir: string
    beforeEach(async () => { dir = path.join(root, 'w'); await mkdir(dir) })
    const put = (value: unknown) => write(dir, RESULT_PATH, JSON.stringify(value))

    it('is read with its moves and checks', async () => {
      const value = { kind: 'relocate-checks', moves: [{ from: 'tests/rumba/c1.test.ts', to: 'test/profile.test.ts' }], checks: [{ criterionId: 'c1', command: 'npx vitest run test/profile.test.ts', files: ['test/profile.test.ts'] }] }
      await put(value)
      expect(await readAgentResult(dir, 'relocate-checks')).toEqual(value)
    })

    it('refuses a move outside the repository', async () => {
      await put({ kind: 'relocate-checks', moves: [{ from: 'tests/rumba/c1.test.ts', to: '../elsewhere.test.ts' }], checks: [] })
      await expect(readAgentResult(dir, 'relocate-checks')).rejects.toThrow(/moves\.0\.to/)
    })
  })
})

describe('GitWorkspace, for relocation', () => {
  let clone: string
  let ws: GitWorkspace
  const git = async (cwd: string, ...args: string[]) =>
    (await execa('git', ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdin: 'ignore' })).stdout.trim()

  beforeEach(async () => {
    const remote = path.join(root, 'remote.git')
    await mkdir(remote)
    await git(remote, 'init', '-q', '--bare')
    await git(root, 'clone', '-q', remote, 'clone')
    clone = path.join(root, 'clone')
    await write(clone, 'test/a.test.js', 'existing\n')
    await git(clone, 'add', '-A')
    await git(clone, 'commit', '-q', '-m', 'initial')
    await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    ws = new GitWorkspace({ repoRoot: clone, defaultBranch: 'main' })
  })

  afterEach(async () => { await ws.cleanupAll() })

  it('reads a file as a commit holds it, and nothing for a missing file or a link', async () => {
    const { workdir } = await ws.prepare('rumba/shop/1', { fresh: true })
    await write(workdir, 'tests/rumba/c1.test.js', 'check\n')
    await symlink('c1.test.js', path.join(workdir, 'tests/rumba/link.js'))
    const sha = (await ws.commit(workdir, 'checks'))!
    await write(workdir, 'tests/rumba/c1.test.js', 'changed on disk\n')
    expect(await ws.readFileAt(workdir, sha, 'tests/rumba/c1.test.js')).toBe('check\n')
    expect(await ws.readFileAt(workdir, sha, 'tests/rumba/missing.js')).toBeNull()
    expect(await ws.readFileAt(workdir, sha, 'tests/rumba/link.js')).toBeNull()
    expect(await ws.readFileAt(workdir, sha, 'tests/rumba')).toBeNull()
  })

  it('refuses to read a file that is not UTF-8 text, so two files never read the same', async () => {
    const { workdir } = await ws.prepare('rumba/shop/1', { fresh: true })
    await writeFile(path.join(workdir, 'test', 'bytes.test.js'), Buffer.from([0x61, 0xff, 0x62]))
    const sha = (await ws.commit(workdir, 'bytes'))!
    await expect(ws.readFileAt(workdir, sha, 'test/bytes.test.js')).rejects.toThrow(/not UTF-8/)
  })

  it('starts a branch like another one: from the commit that one started from, not from the default branch now', async () => {
    const fix = await ws.prepare('rumba/shop/1', { fresh: true })
    // The default branch moves on after the fix branch was made.
    await write(clone, 'later.txt', 'later\n')
    await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'later'); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    const scratch = await ws.prepare('rumba/shop/1-relocated-base', { fresh: true, like: 'rumba/shop/1' })
    expect(scratch.baseSha).toBe(fix.baseSha)
    const trusted = await ws.trustedCheckout('rumba/shop/1-relocated-base')
    expect(existsSync(path.join(trusted, 'later.txt'))).toBe(false)
  })

  it('sets files to their content at a commit, deleting those the commit does not have', async () => {
    const { workdir } = await ws.prepare('rumba/shop/1', { fresh: true })
    await write(workdir, 'tests/rumba/c1.test.js', 'check\n')
    const checks = (await ws.commit(workdir, 'checks'))!
    await rm(path.join(workdir, 'tests/rumba/c1.test.js'))
    await write(workdir, 'test/a.test.js', 'existing\ncheck\n')
    const relocated = (await ws.commit(workdir, 'relocate'))!

    const scratch = await ws.prepare('rumba/shop/1-relocated-base', { fresh: true })
    await ws.reset(scratch.workdir, checks)
    await ws.checkoutFiles(scratch.workdir, relocated, ['test/a.test.js', 'tests/rumba/c1.test.js'])
    expect(await readFile(path.join(scratch.workdir, 'test/a.test.js'), 'utf8')).toBe('existing\ncheck\n')
    expect(existsSync(path.join(scratch.workdir, 'tests/rumba/c1.test.js'))).toBe(false)
    const sha = (await ws.commit(scratch.workdir, 'relocated checks on the base', { allowEmpty: true }))!
    expect(await ws.readFileAt(scratch.workdir, sha, 'test/a.test.js')).toBe('existing\ncheck\n')
    expect(await ws.readFileAt(scratch.workdir, sha, 'tests/rumba/c1.test.js')).toBeNull()
    // The fix branch is not touched.
    expect(await git(clone, 'rev-parse', 'rumba/shop/1')).toBe(relocated)
  })
})
