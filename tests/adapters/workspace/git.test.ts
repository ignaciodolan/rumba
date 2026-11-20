import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorkspace } from '../../../src/adapters/workspace/git.js'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await execa('git', ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdin: 'ignore' })
  return r.stdout.trim()
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const file = path.join(dir, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

describe('GitWorkspace', () => {
  let root: string
  let clone: string
  let ws: GitWorkspace

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-ws-test-')))
    const remote = path.join(root, 'remote.git')
    await mkdir(remote)
    await git(remote, 'init', '-q', '--bare')
    await git(root, 'clone', '-q', remote, 'clone')
    clone = path.join(root, 'clone')
    await write(clone, 'README.md', 'hello')
    await git(clone, 'add', 'README.md')
    await git(clone, 'commit', '-q', '-m', 'initial')
    await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    await git(clone, 'fetch', '-q', 'origin')
    ws = new GitWorkspace({ repoRoot: clone, defaultBranch: 'main' })
  })

  afterEach(async () => {
    await ws.cleanupAll()
    await rm(root, { recursive: true, force: true })
  })

  it('prepares a fresh worktree on a new branch at the default branch head', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    expect(await git(workdir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('rumba/hub/1'); expect(baseSha).toBe(await git(clone, 'rev-parse', 'origin/main'))
  })

  it('commits changes but never .rumba-out', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    await write(workdir, 'a.txt', 'x'); await write(workdir, '.rumba-out/result.json', '{}')
    const sha = await ws.commit(workdir, 'fix: a'); expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(await ws.changedFiles(workdir, baseSha)).toEqual(['a.txt']); expect(await ws.commit(workdir, 'again')).toBeNull()
  })

  it('starts again from the base when the branch already exists', async () => {
    const first = await ws.prepare('rumba/hub/1', { fresh: true }); await write(first.workdir, 'old.txt', 'x'); await ws.commit(first.workdir, 'old attempt')
    const second = await ws.prepare('rumba/hub/1', { fresh: true })
    expect(await ws.changedFiles(second.workdir, second.baseSha)).toEqual([])
  })

  it('reuses the branch when not fresh', async () => {
    const first = await ws.prepare('rumba/hub/1', { fresh: true }); await write(first.workdir, 'kept.txt', 'x'); await ws.commit(first.workdir, 'work')
    await ws.cleanup(first.workdir); const again = await ws.prepare('rumba/hub/1', { fresh: false })
    expect(await ws.changedFiles(again.workdir, first.baseSha)).toEqual(['kept.txt'])
  })

  it('resets to a commit and hashes files', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true }); await write(workdir, 'a.txt', 'x'); await ws.commit(workdir, 'c')
    const h = await ws.hashFiles(workdir, ['a.txt', 'missing.txt']); expect(Object.keys(h)).toEqual(['a.txt'])
    await ws.reset(workdir, baseSha); expect(await ws.changedFiles(workdir, baseSha)).toEqual([])
  })

  it('cleanupAll removes every worktree it made', async () => {
    const a = await ws.prepare('rumba/hub/1', { fresh: true }); const b = await ws.prepare('rumba/hub/2', { fresh: true })
    await ws.cleanupAll(); expect(existsSync(a.workdir)).toBe(false); expect(existsSync(b.workdir)).toBe(false)
  })

  it('places the worktree in a rumba- temp dir and returns its real path', async () => {
    const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
    expect(workdir).toBe(await realpath(workdir))
    expect(path.basename(workdir)).toMatch(/^rumba-/)
    expect(path.dirname(workdir)).toBe(await realpath(tmpdir()))
  })

  it('commits as the Rumba bot and returns the new HEAD', async () => {
    const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
    await write(workdir, 'a.txt', 'x')
    const sha = await ws.commit(workdir, 'fix: a')
    expect(await git(clone, 'log', '-1', '--format=%H %an <%ae> %cn <%ce> %s', 'rumba/hub/1'))
      .toBe(`${sha} Rumba <rumba@users.noreply.github.com> Rumba <rumba@users.noreply.github.com> fix: a`)
  })

  it('leaves .rumba-out out of the commit when the project ignores nothing', async () => {
    const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
    await write(workdir, '.rumba-out/result.json', '{}')
    expect(await ws.commit(workdir, 'only output')).toBeNull()
  })

  it('reset also removes untracked files', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    await write(workdir, 'a.txt', 'x'); await ws.commit(workdir, 'c')
    await write(workdir, 'stray/file.txt', 'y')
    await ws.reset(workdir, baseSha)
    expect(existsSync(path.join(workdir, 'a.txt'))).toBe(false)
    expect(existsSync(path.join(workdir, 'stray'))).toBe(false)
    expect(await git(clone, 'rev-parse', 'rumba/hub/1')).toBe(baseSha)
  })

  it('keeps the branch when it cleans up a worktree', async () => {
    const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
    await ws.cleanup(workdir)
    expect(existsSync(workdir)).toBe(false)
    expect(await git(clone, 'branch', '--list', 'rumba/hub/1')).toContain('rumba/hub/1')
    await expect(ws.cleanup(workdir)).resolves.toBeUndefined()
  })

  it('reuses its own worktree when not fresh', async () => {
    const first = await ws.prepare('rumba/hub/1', { fresh: true })
    const again = await ws.prepare('rumba/hub/1', { fresh: false })
    expect(again).toEqual(first)
  })

  it('refuses to reuse a branch that does not exist', async () => {
    await expect(ws.prepare('rumba/hub/9', { fresh: false })).rejects.toThrow(/rumba\/hub\/9/)
  })

  it('refuses a workdir that is not one of its worktrees', async () => {
    const stray = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-ws-stray-')))
    try {
      await git(stray, 'init', '-q')
      await write(stray, 'a.txt', 'x')
      await expect(ws.commit(stray, 'nope')).rejects.toThrow(/not a worktree/)
      await expect(ws.commit(clone, 'nope')).rejects.toThrow(/not a worktree/)
    } finally {
      await rm(stray, { recursive: true, force: true })
    }
  })

  it('never removes the main checkout, even when it has the branch checked out', async () => {
    await git(clone, 'checkout', '-q', '-b', 'rumba/hub/1')
    await expect(ws.prepare('rumba/hub/1', { fresh: true })).rejects.toThrow(/not a worktree/)
    await expect(ws.cleanup(clone)).rejects.toThrow(/not a worktree/)
    expect(existsSync(path.join(clone, 'README.md'))).toBe(true)
  })

  it('finds a worktree another instance made', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    await write(workdir, 'a.txt', 'x')
    const other = new GitWorkspace({ repoRoot: clone, defaultBranch: 'main' })
    expect(await other.commit(workdir, 'c')).toMatch(/^[0-9a-f]{40}$/)
    expect(await other.prepare('rumba/hub/1', { fresh: false })).toEqual({ workdir, baseSha })
  })

  it('ignores git metadata and hooks the agent planted in the workdir', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    const fsmonitorMarker = path.join(root, 'fsmonitor-ran')
    const hookMarker = path.join(root, 'hook-ran')
    const planted = path.join(workdir, '.git')
    await rm(planted)
    await mkdir(path.join(planted, 'hooks'), { recursive: true })
    await writeFile(path.join(planted, 'config'), `[core]\n\tfsmonitor = touch '${fsmonitorMarker}'\n\thooksPath = ${path.join(planted, 'hooks')}\n`)
    await writeFile(path.join(planted, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(path.join(planted, 'hooks', 'pre-commit'), `#!/bin/sh\ntouch '${hookMarker}'\n`)
    await chmod(path.join(planted, 'hooks', 'pre-commit'), 0o755)
    // A hook in the trusted checkout does not run either.
    const trustedHook = path.join(clone, '.git', 'hooks', 'pre-commit')
    await writeFile(trustedHook, `#!/bin/sh\ntouch '${hookMarker}'\n`)
    await chmod(trustedHook, 0o755)

    await write(workdir, 'a.txt', 'x')
    const sha = await ws.commit(workdir, 'fix: a')
    expect(await git(clone, 'log', '-1', '--format=%H', 'rumba/hub/1')).toBe(sha)
    expect(await ws.changedFiles(workdir, baseSha)).toEqual(['a.txt'])
    await ws.reset(workdir, baseSha)
    expect(await git(clone, 'rev-parse', 'rumba/hub/1')).toBe(baseSha)
    await ws.cleanup(workdir)
    expect(existsSync(workdir)).toBe(false)
    expect(existsSync(fsmonitorMarker)).toBe(false)
    expect(existsSync(hookMarker)).toBe(false)
  })

  describe('hashFiles', () => {
    it('hashes file contents with SHA-256', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'dir/a.txt', 'x')
      expect(await ws.hashFiles(workdir, ['dir/a.txt'])).toEqual({ 'dir/a.txt': createHash('sha256').update('x').digest('hex') })
    })

    it('hashes a symbolic link by its target instead of following it', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      const outside = path.join(root, 'secret.txt')
      await writeFile(outside, 'secret')
      await symlink(outside, path.join(workdir, 'link'))
      expect(await ws.hashFiles(workdir, ['link'])).toEqual({ link: createHash('sha256').update(outside).digest('hex') })
    })

    it('refuses a path that resolves outside the workdir', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await writeFile(path.join(root, 'secret.txt'), 'secret')
      await symlink(root, path.join(workdir, 'up'))
      await expect(ws.hashFiles(workdir, ['../secret.txt'])).rejects.toThrow(/outside/)
      await expect(ws.hashFiles(workdir, [path.join(root, 'secret.txt')])).rejects.toThrow(/outside/)
      await expect(ws.hashFiles(workdir, ['up/secret.txt'])).rejects.toThrow(/outside/)
    })
  })
})
