import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gitAuthEnv, GitHubCodeHost } from '../../../src/adapters/codeHost/github.js'
import { httpError, route, stubOctokit } from '../tracker/githubStub.js'

const TOKEN = 'ghp_faketoken0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`).toString('base64')

interface Pull { number: number; html_url: string; head: string; title: string; body: string }

function makeHost(o: { html_url?: string; existing?: Pull[]; remoteUrl?: string; deleteStatus?: number } = {}) {
  const pulls = [...(o.existing ?? [])]
  const requests: Record<string, unknown>[] = []
  const stub = stubOctokit([
    route('GET', /^\/repos\/o\/r$/, () => ({ default_branch: 'trunk' })),
    route('POST', /^\/repos\/o\/r\/pulls$/, (req) => {
      requests.push(req.body)
      if (pulls.some((p) => p.head === req.body.head)) throw httpError(422, 'A pull request already exists for o:rumba/hub/1.')
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
  const host = new GitHubCodeHost({ octokit: stub.octokit, owner: 'o', repo: 'r', token: TOKEN, remoteUrl: o.remoteUrl })
  return { host, requests, pulls, calls: stub.requests }
}

describe('GitHubCodeHost API calls', () => {
  it('opens a pull request and returns its URL', async () => {
    const { host, requests } = makeHost({ html_url: 'https://github.com/o/r/pull/7' })
    expect(await host.openPullRequest({ title: 'T', body: 'B', head: 'rumba/hub/1', base: 'main', draft: true })).toBe('https://github.com/o/r/pull/7')
    expect(requests[0]).toMatchObject({ title: 'T', head: 'rumba/hub/1', base: 'main', draft: true })
  })

  it('updates and returns the open pull request when one already exists for the head', async () => {
    const existing = { number: 3, html_url: 'https://github.com/o/r/pull/3', head: 'rumba/hub/1', title: 'Old', body: 'Old body' }
    const { host, pulls } = makeHost({ existing: [existing] })
    expect(await host.openPullRequest({ title: 'T', body: 'B', head: 'rumba/hub/1', base: 'main', draft: true })).toBe('https://github.com/o/r/pull/3')
    expect(pulls[0]).toMatchObject({ title: 'T', body: 'B' })
  })

  it('reads the default branch', async () => {
    expect(await makeHost().host.defaultBranch()).toBe('trunk')
  })

  it('deletes a branch by its ref', async () => {
    const { host, calls } = makeHost()
    await host.deleteBranch('rumba/hub/1')
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/repos/o/r/git/refs/heads/rumba/hub/1' })
  })

  it.each([404, 422])('treats a %i for a branch that is already gone as success', async (status) => {
    await expect(makeHost({ deleteStatus: status }).host.deleteBranch('rumba/hub/1')).resolves.toBeUndefined()
  })

  it('does not hide other delete failures', async () => {
    await expect(makeHost({ deleteStatus: 500 }).host.deleteBranch('rumba/hub/1')).rejects.toThrow()
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

  const git = (cwd: string, ...args: string[]) =>
    execa('git', ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...args], { cwd })

  async function workdirWith(file: string): Promise<string> {
    const dir = await mkdtemp(path.join(root, 'work-'))
    await git(dir, 'init', '-q')
    await writeFile(path.join(dir, file), file)
    await git(dir, 'add', '.')
    await git(dir, 'commit', '-q', '-m', file)
    return dir
  }

  const remoteSha = async (branch: string) => (await git(remote, 'rev-parse', `refs/heads/${branch}`)).stdout.trim()
  const headSha = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).stdout.trim()

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rumba-push-'))
    // The token is in the remote's path, so any git output naming the remote contains it.
    remote = path.join(root, TOKEN, 'remote.git')
    await mkdir(remote, { recursive: true })
    await git(remote, 'init', '-q', '--bare')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates the branch on the first push', async () => {
    const work = await workdirWith('a.txt')
    await makeHost({ remoteUrl: remote }).host.pushBranch(work, 'rumba/hub/1')
    expect(await remoteSha('rumba/hub/1')).toBe(await headSha(work))
  })

  it('replaces a branch left by an earlier attempt when forced', async () => {
    const { host } = makeHost({ remoteUrl: remote })
    await host.pushBranch(await workdirWith('a.txt'), 'rumba/hub/1')
    const again = await workdirWith('b.txt')
    await host.pushBranch(again, 'rumba/hub/1', { force: true })
    expect(await remoteSha('rumba/hub/1')).toBe(await headSha(again))
  })

  it('creates the branch when forced and the branch does not exist yet', async () => {
    const work = await workdirWith('a.txt')
    await makeHost({ remoteUrl: remote }).host.pushBranch(work, 'rumba/hub/1', { force: true })
    expect(await remoteSha('rumba/hub/1')).toBe(await headSha(work))
  })

  it('rejects an unrelated history without force, with no token in the error', async () => {
    const { host } = makeHost({ remoteUrl: remote })
    await host.pushBranch(await workdirWith('a.txt'), 'rumba/hub/1')
    const error = await host.pushBranch(await workdirWith('b.txt'), 'rumba/hub/1').then(() => null, (e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toMatch(/rejected/)
    expect(error!.message).not.toContain(TOKEN)
    expect(error!.message).not.toContain(BASIC)
    expect(error!.message).toContain('[redacted]')
  })

  it('runs no hook from the working copy', async () => {
    const work = await workdirWith('a.txt')
    const marker = path.join(root, 'hook-ran')
    const hook = path.join(work, '.git', 'hooks', 'pre-push')
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    await chmod(hook, 0o755)
    await makeHost({ remoteUrl: remote }).host.pushBranch(work, 'rumba/hub/1')
    expect(existsSync(marker)).toBe(false)
  })
})
