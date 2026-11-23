import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitAuthEnv, GitHubCodeHost } from '../../../src/adapters/codeHost/github.js'
import { CodeHostIdentityError } from '../../../src/ports/codeHost.js'
import { httpError, paged, route, stubOctokit } from '../tracker/githubStub.js'

const TOKEN = 'ghp_faketoken0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')

interface Pull { number: number; html_url: string; head: string; title: string; body: string }

function makeHost(o: { html_url?: string; existing?: Pull[]; remoteUrl?: string; repoRoot?: string; deleteStatus?: number } = {}) {
  const pulls = [...(o.existing ?? [])]
  const requests: Record<string, unknown>[] = []
  const stub = stubOctokit([
    route('GET', /^\/repos\/o\/r$/, () => ({ default_branch: 'trunk' })),
    route('POST', /^\/repos\/o\/r\/pulls$/, (req) => {
      requests.push(req.body)
      if (pulls.some((p) => p.head === req.body.head)) throw httpError(422, 'A pull request already exists for o:rumba/shop/1.')
      return { number: 7, html_url: o.html_url ?? 'https://github.com/o/r/pull/7' }
    }),
    route('GET', /^\/repos\/o\/r\/pulls$/, (req) =>
      pulls.filter((p) => req.query.get('state') === 'open' && `o:${p.head}` === req.query.get('head')).map((p) => ({ ...p }))),
    route('PATCH', /^\/repos\/o\/r\/pulls\/(\d+)$/, (req, [n]) => {
      const p = pulls.find((x) => x.number === Number(n))!
      Object.assign(p, req.body)
      return p
    }),
    route('DELETE', /^\/repos\/o\/r\/git\/refs\/(.+)$/, () => {
      if (o.deleteStatus) throw httpError(o.deleteStatus)
      return null
    }),
  ])
  const host = new GitHubCodeHost({ octokit: stub.octokit, owner: 'o', repo: 'r', token: TOKEN, repoRoot: o.repoRoot ?? path.join(tmpdir(), 'rumba-unused-checkout'), remoteUrl: o.remoteUrl })
  return { host, requests, pulls, calls: stub.requests }
}

describe('GitHubCodeHost API calls', () => {
  it('opens a pull request and returns its URL', async () => {
    const { host, requests } = makeHost({ html_url: 'https://github.com/o/r/pull/7' })
    expect(await host.openPullRequest({ title: 'T', body: 'B', head: 'rumba/shop/1', base: 'main', draft: true })).toBe('https://github.com/o/r/pull/7')
    expect(requests[0]).toMatchObject({ title: 'T', head: 'rumba/shop/1', base: 'main', draft: true })
  })

  it('updates and returns the open pull request when one already exists for the head', async () => {
    const existing = { number: 3, html_url: 'https://github.com/o/r/pull/3', head: 'rumba/shop/1', title: 'Old', body: 'Old body' }
    const { host, pulls } = makeHost({ existing: [existing] })
    expect(await host.openPullRequest({ title: 'T', body: 'B', head: 'rumba/shop/1', base: 'main', draft: true })).toBe('https://github.com/o/r/pull/3')
    expect(pulls[0]).toMatchObject({ title: 'T', body: 'B' })
  })

  it('reads the default branch', async () => {
    expect(await makeHost().host.defaultBranch()).toBe('trunk')
  })

  it('deletes a branch by its ref', async () => {
    const { host, calls } = makeHost()
    await host.deleteBranch('rumba/shop/1')
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/repos/o/r/git/refs/heads/rumba/shop/1' })
  })

  it.each([404, 422])('treats a %i for a branch that is already gone as success', async (status) => {
    await expect(makeHost({ deleteStatus: status }).host.deleteBranch('rumba/shop/1')).resolves.toBeUndefined()
  })

  it('does not hide other delete failures', async () => {
    await expect(makeHost({ deleteStatus: 500 }).host.deleteBranch('rumba/shop/1')).rejects.toThrow()
  })
})

describe('GitHubCodeHost.getPullRequest', () => {
  const URL7 = 'https://github.com/o/r/pull/7'

  function hostWith(data: Record<string, unknown> | number) {
    const stub = stubOctokit([
      route('GET', /^\/repos\/o\/r\/pulls\/7$/, () => {
        if (typeof data === 'number') throw httpError(data)
        return data
      }),
    ])
    const host = new GitHubCodeHost({ octokit: stub.octokit, owner: 'o', repo: 'r', token: TOKEN, repoRoot: path.join(tmpdir(), 'rumba-unused-checkout') })
    return { host, calls: stub.requests }
  }

  it('reports an open pull request with its head commit', async () => {
    const { host } = hostWith({ state: 'open', merged: false, merged_at: null, closed_at: null, head: { sha: 'abc' }, labels: [] })
    expect(await host.getPullRequest(URL7)).toEqual({ state: 'open', headSha: 'abc', labels: [] })
  })

  it('reports the labels of the pull request', async () => {
    const { host } = hostWith({ state: 'open', merged: false, head: { sha: 'abc' }, labels: [{ name: 'revise' }, { name: 'x' }] })
    expect((await host.getPullRequest(URL7)).labels).toEqual(['revise', 'x'])
  })

  it('reports a merged pull request with the time it merged', async () => {
    const { host } = hostWith({ state: 'closed', merged: true, merged_at: '2026-01-02T00:00:00Z', closed_at: '2026-01-02T00:00:00Z', head: { sha: 'abc' }, labels: [] })
    expect(await host.getPullRequest(URL7)).toMatchObject({ state: 'merged', headSha: 'abc', mergedAt: '2026-01-02T00:00:00Z' })
  })

  it('reports a pull request closed without merging', async () => {
    const { host } = hostWith({ state: 'closed', merged: false, merged_at: null, closed_at: '2026-01-03T00:00:00Z', head: { sha: 'abc' }, labels: [] })
    expect(await host.getPullRequest(URL7)).toEqual({ state: 'closed', headSha: 'abc', labels: [], closedAt: '2026-01-03T00:00:00Z' })
  })

  it('accepts the host owner and repository in any letter case', async () => {
    const { host } = hostWith({ state: 'open', merged: false, head: { sha: 'abc' }, labels: [] })
    await expect(host.getPullRequest('https://github.com/O/R/pull/7')).resolves.toMatchObject({ state: 'open' })
  })

  it.each([
    'https://github.com/other/r/pull/7',
    'https://github.com/o/other/pull/7',
    'https://github.com/o/r/issues/7',
    'https://github.com/o/r/pull/7/files',
    'https://example.test/o/r/pull/7',
    'not a url',
  ])('refuses %s before any request is made', async (url) => {
    const { host, calls } = hostWith({ state: 'open', head: { sha: 'abc' }, labels: [] })
    await expect(host.getPullRequest(url)).rejects.toThrow(/pull request/i)
    expect(calls).toEqual([])
  })

  it('lets a 404 propagate', async () => {
    await expect(hostWith(404).host.getPullRequest(URL7)).rejects.toMatchObject({ status: 404 })
  })
})

describe('GitHubCodeHost feedback and labels', () => {
  const URL7 = 'https://github.com/o/r/pull/7'
  const user = (login: string, type = 'User') => ({ login, type })

  interface Setup {
    reviews?: object[]
    lineComments?: object[]
    comments?: object[]
    permissions?: Record<string, string | number>
    login?: string
    viewerLogin?: string | null
    userLogin?: string | null
    labels?: string[]
  }

  function setup(o: Setup = {}) {
    const labels = [...(o.labels ?? ['revise', 'other'])]
    const lookups: string[] = []
    const stub = stubOctokit([
      route('POST', /^\/graphql$/, () => {
        if (o.viewerLogin === null) return { data: null, errors: [{ message: 'nope' }] }
        return { data: { viewer: { login: o.viewerLogin ?? 'rumba-bot' } } }
      }),
      route('GET', /^\/user$/, () => {
        if (o.userLogin === null || o.userLogin === undefined) throw httpError(403)
        return { login: o.userLogin }
      }),
      route('GET', /^\/repos\/o\/r\/pulls\/7\/reviews$/, (req) => paged(req, o.reviews ?? [])),
      route('GET', /^\/repos\/o\/r\/pulls\/7\/comments$/, (req) => paged(req, o.lineComments ?? [])),
      route('GET', /^\/repos\/o\/r\/issues\/7\/comments$/, (req) => paged(req, o.comments ?? [])),
      route('GET', /^\/repos\/o\/r\/collaborators\/([^/]+)\/permission$/, (_req, [who]) => {
        lookups.push(who!)
        const p = (o.permissions ?? {})[who!]
        if (typeof p === 'number') throw httpError(p)
        if (p === undefined) throw httpError(404)
        return { permission: p }
      }),
      route('DELETE', /^\/repos\/o\/r\/issues\/7\/labels\/(.+)$/, (_req, [name]) => {
        if (!labels.includes(name!)) throw httpError(404, 'Label does not exist')
        labels.splice(labels.indexOf(name!), 1)
        return []
      }),
    ])
    const host = new GitHubCodeHost({
      octokit: stub.octokit, owner: 'o', repo: 'r', token: TOKEN, repoRoot: path.join(tmpdir(), 'rumba-unused-checkout'),
      ...(o.login === undefined ? {} : { login: o.login }),
    })
    return { host, calls: stub.requests, lookups, labels }
  }

  const review = (o: object = {}) => ({ id: 1, user: user('alice'), body: 'Please rename it', state: 'CHANGES_REQUESTED', submitted_at: '2026-01-02T10:00:00Z', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1', ...o })
  const line = (o: object = {}) => ({ id: 2, user: user('alice'), body: 'Why here?', path: 'src/a.ts', line: 12, created_at: '2026-01-02T11:00:00Z', html_url: 'https://github.com/o/r/pull/7#discussion_r2', ...o })
  const comment = (o: object = {}) => ({ id: 3, user: user('alice'), body: 'Thanks', created_at: '2026-01-02T12:00:00Z', html_url: 'https://github.com/o/r/pull/7#issuecomment-3', ...o })
  const WRITE = { alice: 'write', mallory: 'read' }

  it('maps a review, a line comment and a pull request comment', async () => {
    const { host } = setup({ reviews: [review()], lineComments: [line()], comments: [comment()], permissions: WRITE, login: 'rumba-bot' })
    const items = await host.listFeedback(URL7, '2026-01-01T00:00:00Z')
    expect(items).toEqual([
      { kind: 'review', author: 'alice', url: 'https://github.com/o/r/pull/7#pullrequestreview-1', at: '2026-01-02T10:00:00Z', text: 'Please rename it', reviewState: 'changes_requested', canWrite: true, self: false },
      { kind: 'line', author: 'alice', url: 'https://github.com/o/r/pull/7#discussion_r2', at: '2026-01-02T11:00:00Z', text: 'Why here?', path: 'src/a.ts', line: 12, canWrite: true, self: false },
      { kind: 'comment', author: 'alice', url: 'https://github.com/o/r/pull/7#issuecomment-3', at: '2026-01-02T12:00:00Z', text: 'Thanks', canWrite: true, self: false },
    ])
  })

  it.each([['APPROVED', 'approved'], ['COMMENTED', 'commented'], ['CHANGES_REQUESTED', 'changes_requested']])('maps the review state %s', async (state, want) => {
    const { host } = setup({ reviews: [review({ state })], permissions: WRITE, login: 'rumba-bot' })
    expect((await host.listFeedback(URL7, '2026-01-01T00:00:00Z'))[0]?.reviewState).toBe(want)
  })

  it('skips reviews that are pending or dismissed', async () => {
    const { host } = setup({ reviews: [review({ state: 'PENDING', submitted_at: null }), review({ id: 9, state: 'DISMISSED' })], permissions: WRITE, login: 'rumba-bot' })
    expect(await host.listFeedback(URL7, '2026-01-01T00:00:00Z')).toEqual([])
  })

  it('reports only items strictly after since', async () => {
    const { host } = setup({ comments: [comment({ id: 4, created_at: '2026-01-02T12:00:00Z' }), comment({ id: 5, created_at: '2026-01-02T12:00:01Z', body: 'newer' })], permissions: WRITE, login: 'rumba-bot' })
    const items = await host.listFeedback(URL7, '2026-01-02T12:00:00Z')
    expect(items.map((i) => i.text)).toEqual(['newer'])
  })

  it.each([
    ['admin', true], ['maintain', true], ['write', true], ['read', false], ['triage', false], ['none', false],
  ])('treats the %s permission as canWrite %s', async (permission, want) => {
    const { host } = setup({ comments: [comment()], permissions: { alice: permission }, login: 'rumba-bot' })
    expect((await host.listFeedback(URL7, '2026-01-01T00:00:00Z'))[0]?.canWrite).toBe(want)
  })

  it('looks a permission up once per author', async () => {
    const { host, lookups } = setup({ reviews: [review()], lineComments: [line()], comments: [comment(), comment({ id: 8, user: user('mallory') })], permissions: WRITE, login: 'rumba-bot' })
    const items = await host.listFeedback(URL7, '2026-01-01T00:00:00Z')
    expect(items.map((i) => i.canWrite)).toEqual([true, true, true, false])
    expect(lookups.sort()).toEqual(['alice', 'mallory'])
  })

  it.each([404, 403, 500])('treats a permission lookup failing with %s as canWrite false', async (status) => {
    const { host } = setup({ comments: [comment()], permissions: { alice: status }, login: 'rumba-bot' })
    expect((await host.listFeedback(URL7, '2026-01-01T00:00:00Z'))[0]?.canWrite).toBe(false)
  })

  it('treats a bot or a missing author as unable to write, without a lookup', async () => {
    const { host, lookups } = setup({ comments: [comment({ user: user('ci-bot[bot]', 'Bot') }), comment({ id: 6, user: null })], permissions: { 'ci-bot[bot]': 'write' }, login: 'rumba-bot' })
    const items = await host.listFeedback(URL7, '2026-01-01T00:00:00Z')
    expect(items.map((i) => [i.author, i.canWrite, i.self])).toEqual([['ci-bot[bot]', false, false], ['', false, false]])
    expect(lookups).toEqual([])
  })

  it('marks the account Rumba runs as, in any letter case', async () => {
    const { host } = setup({ comments: [comment({ user: user('Rumba-Bot') }), comment({ id: 6 })], permissions: { 'Rumba-Bot': 'write', alice: 'write' }, login: 'rumba-bot' })
    const items = await host.listFeedback(URL7, '2026-01-01T00:00:00Z')
    expect(items.map((i) => i.self)).toEqual([true, false])
  })

  it('looks the account up through GraphQL viewer, then GET /user', async () => {
    const viaViewer = setup({ comments: [comment({ user: user('rumba-bot') })], permissions: { 'rumba-bot': 'write' } })
    expect((await viaViewer.host.listFeedback(URL7, '2026-01-01T00:00:00Z'))[0]?.self).toBe(true)
    const viaUser = setup({ comments: [comment({ user: user('rumba-bot') })], permissions: { 'rumba-bot': 'write' }, viewerLogin: null, userLogin: 'rumba-bot' })
    expect((await viaUser.host.listFeedback(URL7, '2026-01-01T00:00:00Z'))[0]?.self).toBe(true)
  })

  it('throws when the account cannot be determined, rather than marking nobody as self', async () => {
    const { host } = setup({ comments: [comment()], permissions: WRITE, viewerLogin: null, userLogin: null })
    await expect(host.listFeedback(URL7, '2026-01-01T00:00:00Z')).rejects.toThrow(/RUMBA_GITHUB_LOGIN/)
    await expect(host.listFeedback(URL7, '2026-01-01T00:00:00Z')).rejects.toBeInstanceOf(CodeHostIdentityError)
  })

  it('reads every page of every list', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => comment({ id: 100 + i, body: `c${i}` }))
    const { host, calls } = setup({ comments: many(250), permissions: WRITE, login: 'rumba-bot' })
    const items = await host.listFeedback(URL7, '2026-01-01T00:00:00Z')
    expect(items).toHaveLength(250)
    expect(calls.filter((c) => c.path.endsWith('/issues/7/comments'))).toHaveLength(3)
  })

  it.each([
    'https://github.com/other/r/pull/7', 'https://github.com/o/r/issues/7', 'not a url',
  ])('refuses %s before any request is made', async (url) => {
    const { host, calls } = setup({ login: 'rumba-bot' })
    await expect(host.listFeedback(url, '2026-01-01T00:00:00Z')).rejects.toThrow(/pull request/i)
    await expect(host.removeLabel(url, 'revise')).rejects.toThrow(/pull request/i)
    expect(calls).toEqual([])
  })

  it('removes a label from the pull request', async () => {
    const { host, labels } = setup()
    await host.removeLabel(URL7, 'revise')
    expect(labels).toEqual(['other'])
  })

  it('does not treat a label that is not there as an error', async () => {
    const { host } = setup({ labels: [] })
    await expect(host.removeLabel(URL7, 'revise')).resolves.toBeUndefined()
  })
})

describe('gitAuthEnv', () => {
  it('clears any stored GitHub auth header, then sets the token header, and disables hooks', () => {
    expect(gitAuthEnv(TOKEN)).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${BASIC}`,
      GIT_CONFIG_KEY_2: 'core.hooksPath',
      GIT_CONFIG_VALUE_2: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    })
  })
})

describe('GitHubCodeHost.pushBranch', () => {
  let root: string
  let remote: string
  let repo: string

  const git = (cwd: string, ...args: string[]) =>
    execa('git', ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...args], { cwd })

  let n = 0
  /** A worktree of the trusted repo holding one commit of `file`, with history unrelated to any other worktree's. */
  async function workdirWith(file: string): Promise<string> {
    n += 1
    const dir = path.join(root, `wt-${n}`)
    await git(repo, 'worktree', 'add', '-q', '--detach', dir)
    await git(dir, 'checkout', '-q', '--orphan', `wt-${n}`)
    await git(dir, 'rm', '-rfq', '.')
    await commitFile(dir, file)
    return dir
  }

  async function commitFile(dir: string, file: string): Promise<void> {
    await writeFile(path.join(dir, file), file)
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', file)
  }

  const host = () => makeHost({ remoteUrl: remote, repoRoot: repo }).host
  const remoteSha = async (branch: string) => (await git(remote, 'rev-parse', `refs/heads/${branch}`)).stdout.trim()
  const headSha = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rumba-push-'))
    // The token is in the remote's path, so any git output naming the remote contains it.
    remote = path.join(root, TOKEN, 'remote.git')
    await mkdir(remote, { recursive: true })
    await git(remote, 'init', '-q', '--bare')
    repo = path.join(root, 'repo')
    await mkdir(repo)
    await git(repo, 'init', '-q')
    await commitFile(repo, 'base.txt')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates the branch on the first push', async () => {
    const work = await workdirWith('a.txt')
    await host().pushBranch(work, 'rumba/shop/1')
    expect(await remoteSha('rumba/shop/1')).toBe(await headSha(work))
  })

  it('replaces a branch left by an earlier attempt when forced', async () => {
    const h = host()
    await h.pushBranch(await workdirWith('a.txt'), 'rumba/shop/1')
    const again = await workdirWith('b.txt')
    await h.pushBranch(again, 'rumba/shop/1', { force: true })
    expect(await remoteSha('rumba/shop/1')).toBe(await headSha(again))
  })

  it('creates the branch when forced and the branch does not exist yet', async () => {
    const work = await workdirWith('a.txt')
    await host().pushBranch(work, 'rumba/shop/1', { force: true })
    expect(await remoteSha('rumba/shop/1')).toBe(await headSha(work))
  })

  it('rejects an unrelated history without force, with no token in the error', async () => {
    const h = host()
    await h.pushBranch(await workdirWith('a.txt'), 'rumba/shop/1')
    const error = await h.pushBranch(await workdirWith('b.txt'), 'rumba/shop/1').then(() => null, (e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toMatch(/rejected/)
    expect(error!.message).not.toContain(TOKEN)
    expect(error!.message).not.toContain(BASIC)
    expect(error!.message).toContain('[redacted]')
  })

  it('runs no hook, even from the trusted checkout', async () => {
    const work = await workdirWith('a.txt')
    const marker = path.join(root, 'hook-ran')
    const hook = path.join(repo, '.git', 'hooks', 'pre-push')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(hook, 0o755)
    await host().pushBranch(work, 'rumba/shop/1')
    expect(existsSync(marker)).toBe(false)
  })

  it('ignores git metadata the agent planted in the workdir', async () => {
    const work = await workdirWith('a.txt')
    const h = host()
    await h.pushBranch(work, 'rumba/shop/1')
    await commitFile(work, 'b.txt')
    const want = await headSha(work)
    // The agent swaps the worktree's .git pointer file for a directory with its own config and hooks.
    const marker = path.join(root, 'planted-ran')
    const planted = path.join(work, '.git')
    await rm(planted)
    await mkdir(path.join(planted, 'hooks'), { recursive: true })
    await writeFile(path.join(planted, 'config'), `[core]\n\tfsmonitor = touch '${marker}'\n\thooksPath = ${path.join(planted, 'hooks')}\n`)
    await writeFile(path.join(planted, 'hooks', 'pre-push'), `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(path.join(planted, 'hooks', 'pre-push'), 0o755)
    await writeFile(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n')
    await h.pushBranch(work, 'rumba/shop/1')
    expect(await remoteSha('rumba/shop/1')).toBe(want)
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a workdir that is not a worktree of the trusted checkout', async () => {
    const stray = path.join(root, 'stray')
    await mkdir(stray)
    await git(stray, 'init', '-q')
    await commitFile(stray, 'a.txt')
    await expect(host().pushBranch(stray, 'rumba/shop/1')).rejects.toThrow(/not a worktree/)
  })
})
