import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('reports unusual file names exactly', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    const names = ['.rumba/hub/é.md', `a b"c'.txt`, 'tab\there.txt', 'new\nline.txt']
    for (const name of names) await write(workdir, name, 'x')
    await ws.commit(workdir, 'unusual names')
    expect((await ws.changedFiles(workdir, baseSha)).sort()).toEqual([...names].sort())
  })

  it('cleanupAll never throws and removes the worktrees it can', async () => {
    const a = await ws.prepare('rumba/hub/1', { fresh: true }); const b = await ws.prepare('rumba/hub/2', { fresh: true })
    // Unregister a's worktree behind the workspace's back, so removing it fails.
    const gitDir = (await readFile(path.join(a.workdir, '.git'), 'utf8')).replace(/^gitdir: /, '').trim()
    await rm(gitDir, { recursive: true, force: true })
    try {
      await expect(ws.cleanupAll()).resolves.toBeUndefined()
      expect(existsSync(b.workdir)).toBe(false)
    } finally {
      // The checkout sits alone in a temp folder of its own; remove that too.
      await rm(path.dirname(a.workdir), { recursive: true, force: true })
    }
  })

  it('cleanupAll removes every worktree it made', async () => {
    const a = await ws.prepare('rumba/hub/1', { fresh: true }); const b = await ws.prepare('rumba/hub/2', { fresh: true })
    await ws.cleanupAll(); expect(existsSync(a.workdir)).toBe(false); expect(existsSync(b.workdir)).toBe(false)
  })

  it('places the worktree in a rumba- temp dir and returns its real path', async () => {
    const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
    expect(workdir).toBe(await realpath(workdir))
    expect(path.basename(workdir)).toMatch(/^rumba-/)
    // Each checkout sits alone in a temp folder of its own, named like it.
    expect(path.basename(path.dirname(workdir))).toBe(path.basename(workdir))
    expect(path.dirname(path.dirname(workdir))).toBe(await realpath(tmpdir()))
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
    // cleanup never throws, so refusing the main checkout means leaving it alone.
    await expect(ws.cleanup(clone)).resolves.toBeUndefined()
    expect(existsSync(path.join(clone, 'README.md'))).toBe(true)
    expect(await git(clone, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('rumba/hub/1')
  })

  it('gives a checkout of only the committed tree after a cleanup', async () => {
    const first = await ws.prepare('rumba/hub/1', { fresh: true })
    await write(first.workdir, '.gitignore', '.env\n')
    await write(first.workdir, 'kept.txt', 'committed')
    await write(first.workdir, '.env', 'COMPOSE_FILE=evil.yml')
    await ws.commit(first.workdir, 'work')
    await write(first.workdir, 'untracked.txt', 'later')
    await ws.cleanup(first.workdir)
    const again = await ws.prepare('rumba/hub/1', { fresh: false })
    expect(again.workdir).not.toBe(first.workdir)
    expect(existsSync(path.join(again.workdir, 'kept.txt'))).toBe(true)
    expect(existsSync(path.join(again.workdir, '.env'))).toBe(false)
    expect(existsSync(path.join(again.workdir, 'untracked.txt'))).toBe(false)
  })

  it('commits with nothing staged when allowEmpty is set', async () => {
    const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
    expect(await ws.commit(workdir, 'nothing')).toBeNull()
    const sha = await ws.commit(workdir, 'test: empty', { allowEmpty: true })
    expect(sha).toMatch(/^[0-9a-f]{40}$/); expect(sha).not.toBe(baseSha)
    expect(await git(clone, 'rev-parse', 'rumba/hub/1')).toBe(sha)
    expect(await ws.changedFiles(workdir, baseSha)).toEqual([])
  })

  describe('when a worktree cannot be deleted', () => {
    let locked: string | undefined
    afterEach(async () => {
      if (locked !== undefined) await chmod(locked, 0o755).catch(() => undefined)
      locked = undefined
    })

    it('cleanup resolves, frees the branch, and a later prepare gets a new directory', async () => {
      const first = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(first.workdir, 'locked/file.txt', 'x')
      await ws.commit(first.workdir, 'work')
      locked = path.join(first.workdir, 'locked')
      await chmod(locked, 0o555)
      await expect(ws.cleanup(first.workdir)).resolves.toBeUndefined()
      expect(await git(clone, 'worktree', 'list', '--porcelain')).not.toContain('branch refs/heads/rumba/hub/1')
      const again = await ws.prepare('rumba/hub/1', { fresh: false })
      expect(again.workdir).not.toBe(first.workdir)
      expect(existsSync(path.join(again.workdir, 'locked', 'file.txt'))).toBe(true)
      await chmod(locked, 0o755); locked = undefined
      await rm(path.dirname(first.workdir), { recursive: true, force: true })
    })
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

  describe('trustedCheckout', () => {
    it('gives a checkout of the commit the branch started from, whatever the branch changed', async () => {
      await write(clone, 'scripts/up.sh', 'echo trusted\n')
      await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'add script'); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
      const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'scripts/up.sh', 'echo agent\n'); await write(workdir, 'new.txt', 'x')
      await ws.commit(workdir, 'agent change')

      const trusted = await ws.trustedCheckout('rumba/hub/1')
      expect(trusted).not.toBe(workdir)
      expect(trusted).toBe(await realpath(trusted))
      expect(await readFile(path.join(trusted, 'scripts/up.sh'), 'utf8')).toBe('echo trusted\n')
      expect(existsSync(path.join(trusted, 'new.txt'))).toBe(false)
      expect(await git(trusted, 'rev-parse', 'HEAD')).toBe(baseSha)
      // Detached: it holds no branch, so the fix branch can still be checked out elsewhere.
      expect(await git(trusted, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    })

    it('stays at the commit the branch started from when the default branch moves on', async () => {
      const { baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(clone, 'later.txt', 'x')
      await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'later'); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); await git(clone, 'fetch', '-q', 'origin')
      const trusted = await ws.trustedCheckout('rumba/hub/1')
      expect(await git(trusted, 'rev-parse', 'HEAD')).toBe(baseSha)
      expect(existsSync(path.join(trusted, 'later.txt'))).toBe(false)
    })

    it('is never handed out as the checkout of the branch', async () => {
      const first = await ws.prepare('rumba/hub/1', { fresh: true })
      await ws.cleanup(first.workdir)
      const trusted = await ws.trustedCheckout('rumba/hub/1')
      const again = await ws.prepare('rumba/hub/1', { fresh: false })
      expect(again.workdir).not.toBe(trusted)
      const second = await ws.trustedCheckout('rumba/hub/1')
      expect(second).not.toBe(trusted)
    })

    it('is removed by cleanup and by cleanupAll', async () => {
      await ws.prepare('rumba/hub/1', { fresh: true })
      const a = await ws.trustedCheckout('rumba/hub/1'); const b = await ws.trustedCheckout('rumba/hub/1')
      await ws.cleanup(a); expect(existsSync(a)).toBe(false); expect(existsSync(b)).toBe(true)
      await ws.cleanupAll(); expect(existsSync(b)).toBe(false)
      expect((await git(clone, 'worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1)
    })

    it('finds the starting commit of a branch another instance prepared', async () => {
      const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'a.txt', 'x'); await ws.commit(workdir, 'c')
      const other = new GitWorkspace({ repoRoot: clone, defaultBranch: 'main' })
      const trusted = await other.trustedCheckout('rumba/hub/1')
      expect(await git(trusted, 'rev-parse', 'HEAD')).toBe(baseSha)
      await other.cleanupAll()
    })

    it('refuses a branch that does not exist', async () => {
      await expect(ws.trustedCheckout('rumba/hub/404')).rejects.toThrow(/rumba\/hub\/404/)
    })
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

    it('refuses a directory', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await mkdir(path.join(workdir, 'dir'))
      await expect(ws.hashFiles(workdir, ['dir'])).rejects.toThrow(/dir is not a regular file/)
    })

    it.skipIf(process.platform === 'win32')('refuses a FIFO without blocking on it', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await execa('mkfifo', [path.join(workdir, 'pipe')])
      await expect(ws.hashFiles(workdir, ['pipe'])).rejects.toThrow(/pipe is not a regular file/)
    }, 3000)

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
