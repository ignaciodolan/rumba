import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorkspace } from '../../src/adapters/workspace/git.js'
import { loadRumba } from '../../src/config/load.js'
import { renderPullRequestBody } from '../../src/core/evidence.js'
import { build } from '../../src/core/steps/build.js'
import { failing, makeDeps, makeRumba, makeTicket, verified } from '../../src/testing/fakes.js'
import { resolveCommitAuthor } from '../../src/wiring.js'

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', ['-c', 'user.name=p', '-c', 'user.email=p@example.test', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdin: 'ignore' })).stdout.trim()
}

describe('the commit author', () => {
  let root: string
  beforeEach(async () => { root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-author-'))) })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  it('commits as the identity the workspace is given, author and committer alike', async () => {
    const remote = path.join(root, 'remote.git'); await mkdir(remote); await git(remote, 'init', '-q', '--bare')
    await git(root, 'clone', '-q', remote, 'clone'); const clone = path.join(root, 'clone')
    await writeFile(path.join(clone, 'a'), 'x'); await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'i'); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); await git(clone, 'fetch', '-q')
    const ws = new GitWorkspace({ repoRoot: clone, defaultBranch: 'main', author: async () => ({ name: 'octo-bot', email: '123+octo-bot@users.noreply.github.com' }) })
    const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
    await writeFile(path.join(workdir, 'b'), 'y')
    await ws.commit(workdir, 'fix: b')
    expect(await git(clone, 'log', '-1', '--format=%an <%ae> / %cn <%ce>', 'rumba/hub/1')).toBe('octo-bot <123+octo-bot@users.noreply.github.com> / octo-bot <123+octo-bot@users.noreply.github.com>')
    await ws.cleanupAll()
  })

  it('reads commit_author from rumba.yml', async () => {
    await mkdir(path.join(root, '.rumba/hub'), { recursive: true })
    await writeFile(path.join(root, '.rumba/hub/rumba.yml'), [
      'paths: ["**"]', 'tracker: { kind: github }', 'agent: { kind: claude-code }',
      'environment: { kind: docker, up: u, exec: e, down: d }', 'commit_author: { name: Deploy Bot, email: deploy@example.test }',
    ].join('\n'))
    expect((await loadRumba(root, 'hub')).commitAuthor).toEqual({ name: 'Deploy Bot', email: 'deploy@example.test' })
  })
})

describe('resolveCommitAuthor', () => {
  const lookup = async () => ({ login: 'octo-bot', id: 123 })
  it('prefers the environment variables, then rumba.yml', async () => {
    expect(await resolveCommitAuthor({ RUMBA_COMMIT_AUTHOR_NAME: 'Env', RUMBA_COMMIT_AUTHOR_EMAIL: 'env@example.test' }, { name: 'Yml', email: 'yml@example.test' }, lookup))
      .toEqual({ name: 'Env', email: 'env@example.test' })
    expect(await resolveCommitAuthor({}, { name: 'Yml', email: 'yml@example.test' }, lookup)).toEqual({ name: 'Yml', email: 'yml@example.test' })
  })
  it('defaults to the GitHub account Rumba runs as, so deployment integrations recognise the author', async () => {
    expect(await resolveCommitAuthor({}, undefined, lookup)).toEqual({ name: 'octo-bot', email: '123+octo-bot@users.noreply.github.com' })
  })
  it('falls back to the Rumba identity when the account cannot be looked up', async () => {
    expect(await resolveCommitAuthor({}, undefined, async () => null)).toEqual({ name: 'Rumba', email: 'rumba@users.noreply.github.com' })
    expect(await resolveCommitAuthor({}, undefined, async () => { throw new Error('403') })).toEqual({ name: 'Rumba', email: 'rumba@users.noreply.github.com' })
  })
  it('refuses only one of the two variables', async () => {
    await expect(resolveCommitAuthor({ RUMBA_COMMIT_AUTHOR_NAME: 'Env' }, undefined, lookup)).rejects.toThrow(/RUMBA_COMMIT_AUTHOR_EMAIL/)
  })
})

describe('the pull request body', () => {
  it('has a summary of the change written by the agent, and closes the GitHub issue', () => {
    const d = makeDeps(); const s = { ...verified(d), fixSummary: 'Lower-cases the slug in `slugify`, as @someone asked.' }
    const body = renderPullRequestBody({ ticket: makeTicket({ ref: '#18', url: 'https://github.com/o/r/issues/18' }), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(body).toMatch(/^## Summary\n\n> Lower-cases the slug in `slugify`, as @​someone asked\./)
    expect(body).toContain('Closes #18')
  })
  it('links a Linear issue without a closing keyword', () => {
    const d = makeDeps()
    const body = renderPullRequestBody({ ticket: makeTicket({ ref: 'ENG-12', url: 'https://linear.app/x/issue/ENG-12' }), rumba: makeRumba({ tracker: { kind: 'linear', team: 'ENG' } }), state: verified(d), outsideScope: [], secrets: [] })
    expect(body).toContain('https://linear.app/x/issue/ENG-12'); expect(body).not.toMatch(/Closes/)
  })
  it('keeps the summary of the fix that passed', async () => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'Lower-cases the slug.' }; d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    expect((await build(d, makeRumba(), makeTicket(), failing(d))).fixSummary).toBe('Lower-cases the slug.')
  })
})
