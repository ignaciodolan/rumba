import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorkspace } from '../../../src/adapters/workspace/git.js'

// What host git does with things an agent, or code in a container, left in a directory.
// Every test uses real git, and each one that says a command "never runs" plants a command
// that creates a marker file, checks the marker is absent after Rumba's git calls, and then
// shows with plain git that the same setup does create it.

const IDENT = ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false']

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', [...IDENT, ...args], { cwd, stdin: 'ignore' })).stdout.trim()
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const file = path.join(dir, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

describe('GitWorkspace against hostile content', () => {
  let root: string
  let clone: string
  let ws: GitWorkspace
  let marker: string
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL

  async function pushToMain(message: string): Promise<void> {
    await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', message); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
  }

  /** The command an attacker wants run on the host: it leaves a marker and passes content through. */
  const leaveMarker = () => `touch '${marker}'; cat`

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-ws-hostile-')))
    marker = path.join(root, 'COMMAND_RAN_ON_HOST')
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
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal
    await ws.cleanupAll()
    await rm(root, { recursive: true, force: true })
  })

  describe('a git repository the agent created inside the worktree', () => {
    /** A nested repository with one tracked file that goes through the filter driver "evil". */
    async function nestedRepo(dir: string): Promise<void> {
      await mkdir(dir, { recursive: true })
      await git(dir, 'init', '-q', '-b', 'main', '.')
      await write(dir, '.gitattributes', 'f filter=evil\n')
      await write(dir, 'f', 'data\n')
      await git(dir, 'add', '-A')
      await git(dir, 'commit', '-q', '-m', 'sub')
    }

    /** Arms the nested repository: its own config defines the driver, and its file looks modified. */
    async function arm(dir: string): Promise<void> {
      await git(dir, 'config', 'filter.evil.clean', leaveMarker())
      const later = new Date(Date.now() + 5000)
      await utimes(path.join(dir, 'f'), later, later)
    }

    it('commit refuses before git can enter a nested repository, so its filter driver never runs', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      const gitDir = await git(workdir, 'rev-parse', '--absolute-git-dir')
      const explicit = ['--git-dir', gitDir, '--work-tree', workdir]
      // The state the old code could reach: the nested repository is already tracked as a gitlink.
      await nestedRepo(path.join(workdir, 'sub'))
      await git(workdir, ...explicit, 'add', '-A')
      await git(workdir, ...explicit, 'commit', '-q', '-m', 'gitlink')
      const head = await git(clone, 'rev-parse', 'rumba/hub/1')
      await arm(path.join(workdir, 'sub'))
      await write(workdir, 'fix.txt', 'fix')

      await expect(ws.commit(workdir, 'fix')).rejects.toThrow(/git repository inside.*sub\/\.git/s)
      expect(existsSync(marker)).toBe(false)
      expect(await git(clone, 'rev-parse', 'rumba/hub/1')).toBe(head)
      await expect(ws.reset(workdir, head)).rejects.toThrow(/git repository inside/)
      expect(existsSync(marker)).toBe(false)

      // The same directory with the invocation Rumba used before: the command runs.
      await git(workdir, ...explicit, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'add', '-A', '--', '.', ':(top,exclude).rumba-out')
      expect(existsSync(marker)).toBe(true)
    })

    it('never commits a nested repository as a gitlink', async () => {
      const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await nestedRepo(path.join(workdir, 'vendor/lib'))
      await expect(ws.commit(workdir, 'checks')).rejects.toThrow(/git repository inside.*vendor\/lib\/\.git/s)
      expect(await git(clone, 'rev-parse', 'rumba/hub/1')).toBe(baseSha)
      expect(await git(clone, 'ls-tree', '-r', 'rumba/hub/1')).not.toContain('160000')
    })

    it('refuses a .git entry of any kind, at any depth, and in a folder git ignores', async () => {
      for (const plant of [
        async (w: string) => { await write(w, 'a/b/c/.git', 'gitdir: /somewhere/else\n') },
        async (w: string) => { await write(w, '.gitignore', 'node_modules/\n'); await mkdir(path.join(w, 'node_modules/pkg/.git'), { recursive: true }) },
        async (w: string) => { await mkdir(path.join(w, 'x'), { recursive: true }); await symlink('/tmp', path.join(w, 'x/.git')) },
        async (w: string) => { await mkdir(path.join(w, 'y/.GIT'), { recursive: true }) },
      ]) {
        const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
        await write(workdir, 'ok.txt', 'x')
        await plant(workdir)
        await expect(ws.commit(workdir, 'c')).rejects.toThrow(/git repository inside/)
      }
    })

    it('still works in a repository whose own submodules are not checked out', async () => {
      const other = path.join(root, 'other')
      await mkdir(other); await git(other, 'init', '-q', '-b', 'main', '.'); await write(other, 'x', 'x'); await git(other, 'add', '-A'); await git(other, 'commit', '-q', '-m', 'o')
      await git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', other, 'lib')
      await pushToMain('submodule')
      const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'a.txt', 'x')
      expect(await ws.commit(workdir, 'work')).toMatch(/^[0-9a-f]{40}$/)
      expect(await ws.changedFiles(workdir, baseSha)).toEqual(['a.txt'])
    })

    it('cleanup removes a worktree holding an armed nested repository without running its driver', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await nestedRepo(path.join(workdir, 'sub'))
      await arm(path.join(workdir, 'sub'))
      await ws.cleanup(workdir)
      expect(existsSync(workdir)).toBe(false)
      expect(existsSync(marker)).toBe(false)
      expect(await git(clone, 'worktree', 'list', '--porcelain')).not.toContain('rumba/hub/1')
    })
  })

  describe('filter drivers in the host git configuration', () => {
    /** Plain git: the driver does run for this path when nothing stops it. */
    async function driverIsLive(attrs: string): Promise<boolean> {
      const scratch = path.join(root, `scratch-${Date.now()}`)
      await git(clone, 'worktree', 'add', '-q', '--detach', scratch, 'origin/main')
      await write(scratch, '.gitattributes', attrs)
      await write(scratch, 'probe.txt', 'probe')
      await git(scratch, 'add', '-A')
      const ran = existsSync(marker)
      await rm(marker, { force: true })
      await git(clone, 'worktree', 'remove', '--force', scratch)
      return ran
    }

    it('does not run a driver from the repository config that an agent-written .gitattributes selects', async () => {
      // As `git lfs install --local` leaves a driver in the repository's own config.
      await git(clone, 'config', 'filter.evil.clean', leaveMarker())
      await git(clone, 'config', 'filter.evil.smudge', leaveMarker())
      await git(clone, 'config', 'filter.evil.required', 'true')
      const first = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(first.workdir, '.gitattributes', '*.txt filter=evil\n')
      await write(first.workdir, 'a.txt', 'agent')

      const sha = await ws.commit(first.workdir, 'agent change')
      expect(existsSync(marker)).toBe(false)
      // Checking the commit out again, and resetting to it, would run the smudge side.
      await ws.cleanup(first.workdir)
      const again = await ws.prepare('rumba/hub/1', { fresh: false })
      expect(await readFile(path.join(again.workdir, 'a.txt'), 'utf8')).toBe('agent')
      await rm(path.join(again.workdir, 'a.txt'))
      await ws.reset(again.workdir, sha!)
      expect(await readFile(path.join(again.workdir, 'a.txt'), 'utf8')).toBe('agent')
      expect(existsSync(marker)).toBe(false)

      expect(await driverIsLive('*.txt filter=evil\n')).toBe(true)
    })

    it('does not run a driver from the global config that an agent-written .gitattributes selects', async () => {
      const globalConfig = path.join(root, 'global.gitconfig')
      await writeFile(globalConfig, `[filter "evil"]\n\tclean = "${leaveMarker()}"\n\tsmudge = "${leaveMarker()}"\n\trequired = true\n`)
      process.env.GIT_CONFIG_GLOBAL = globalConfig
      const first = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(first.workdir, '.gitattributes', '*.txt filter=evil\n')
      await write(first.workdir, 'a.txt', 'agent')

      await ws.commit(first.workdir, 'agent change')
      await ws.cleanup(first.workdir)
      await ws.prepare('rumba/hub/1', { fresh: false })
      expect(existsSync(marker)).toBe(false)

      expect(await driverIsLive('*.txt filter=evil\n')).toBe(true)
    })

    it('does not run a driver that the global attributes file selects when it commits agent-written files', async () => {
      const globalConfig = path.join(root, 'global.gitconfig')
      const globalAttributes = path.join(root, 'global.gitattributes')
      await writeFile(globalAttributes, '*.txt filter=evil\n')
      await writeFile(globalConfig, `[core]\n\tattributesFile = ${globalAttributes}\n[filter "evil"]\n\tclean = "${leaveMarker()}"\n`)
      process.env.GIT_CONFIG_GLOBAL = globalConfig
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'a.txt', 'agent')

      await ws.commit(workdir, 'agent change')
      expect(existsSync(marker)).toBe(false)

      expect(await driverIsLive('')).toBe(true)
    })
  })

  describe('attributes from the host, selecting drivers for files the agent names', () => {
    const savedXdg = process.env.XDG_CONFIG_HOME
    afterEach(() => {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
    })

    /** Commits agent-written files, checks the commit out again and resets to it: the clean and the smudge side. */
    async function commitAndCheckOutAgain(files: string[]): Promise<void> {
      const first = await ws.prepare('rumba/hub/1', { fresh: true })
      for (const f of files) await write(first.workdir, f, 'agent')
      const sha = await ws.commit(first.workdir, 'agent change')
      await ws.cleanup(first.workdir)
      const again = await ws.prepare('rumba/hub/1', { fresh: false })
      for (const f of files) expect(await readFile(path.join(again.workdir, f), 'utf8')).toBe('agent')
      await rm(path.join(again.workdir, files[0]))
      await ws.reset(again.workdir, sha!)
    }

    it('does not run a global driver that the global attributes file selects, on commit or on checkout', async () => {
      const globalConfig = path.join(root, 'global.gitconfig')
      const globalAttributes = path.join(root, 'global.gitattributes')
      await writeFile(globalAttributes, '*.dat filter=evil\n')
      await writeFile(globalConfig, `[core]\n\tattributesFile = ${globalAttributes}\n[filter "evil"]\n\tclean = "${leaveMarker()}"\n\tsmudge = "${leaveMarker()}"\n`)
      process.env.GIT_CONFIG_GLOBAL = globalConfig
      await commitAndCheckOutAgain(['agent.dat'])
      expect(existsSync(marker)).toBe(false)
    })

    it('does not run a repository driver that the default attributes file in the home folder selects', async () => {
      // No core.attributesFile anywhere: git falls back to $XDG_CONFIG_HOME/git/attributes.
      process.env.XDG_CONFIG_HOME = path.join(root, 'xdg')
      await write(process.env.XDG_CONFIG_HOME, 'git/attributes', '*.bin filter=evil\n')
      process.env.GIT_CONFIG_GLOBAL = path.join(root, 'empty.gitconfig')
      await writeFile(process.env.GIT_CONFIG_GLOBAL, '')
      await git(clone, 'config', 'filter.evil.clean', leaveMarker())
      await git(clone, 'config', 'filter.evil.smudge', leaveMarker())
      await commitAndCheckOutAgain(['agent.bin'])
      expect(existsSync(marker)).toBe(false)
      // Plain git, same setup: the driver runs.
      await write(clone, 'probe.bin', 'x'); await git(clone, 'add', 'probe.bin')
      expect(existsSync(marker)).toBe(true)
    })

    it("does not run a repository driver that the repository's own info/attributes selects", async () => {
      await git(clone, 'config', 'filter.evil.clean', leaveMarker())
      await git(clone, 'config', 'filter.evil.smudge', leaveMarker())
      await git(clone, 'config', 'filter.evil.required', 'true')
      await write(clone, '.git/info/attributes', '*.lfs filter=evil\n')
      await commitAndCheckOutAgain(['agent.lfs'])
      expect(existsSync(marker)).toBe(false)
      await write(clone, 'probe.lfs', 'x'); await git(clone, 'add', 'probe.lfs')
      expect(existsSync(marker)).toBe(true)
    })
  })

  describe('removing a checkout that something is still writing to', () => {
    it('never deletes outside the checkout when folders are swapped for links during the removal', async () => {
      const victim = path.join(root, 'victim')
      await mkdir(victim)
      for (let i = 0; i < 100; i++) await writeFile(path.join(victim, `keep${i}`), 'x')
      // Stands in for code in a container that still has the checkout mounted: it swaps each
      // folder with a link to the victim folder and back, as fast as it can.
      const racer = [
        "const fs = require('node:fs'), path = require('node:path')",
        'const [target, victim, n] = [process.argv[1], process.argv[2], Number(process.argv[3])]',
        "const d = (i) => path.join(target, 'd' + i), aside = (i) => path.join(target, 'a' + i)",
        'for (;;) {',
        '  for (let i = 0; i < n; i++) try { fs.renameSync(d(i), aside(i)); fs.symlinkSync(victim, d(i)) } catch {}',
        '  for (let i = 0; i < n; i++) try { fs.unlinkSync(d(i)); fs.renameSync(aside(i), d(i)) } catch {}',
        '  if (!fs.existsSync(target)) process.exit(0)',
        '}',
      ].join('\n')
      for (let round = 0; round < 3; round++) {
        const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
        for (let i = 0; i < 150; i++) for (let j = 0; j < 10; j++) await write(workdir, `d${i}/f${j}`, 'x')
        const child = execa('node', ['-e', racer, workdir, victim, '150'], { stdin: 'ignore', reject: false })
        await new Promise((r) => setTimeout(r, 150))
        await ws.cleanup(workdir)
        child.kill('SIGKILL')
        await child
        expect(await readdir(victim)).toHaveLength(100)
        // The racing writer may have kept the removal from finishing; what is left is this test's to remove.
        await rm(path.dirname(workdir), { recursive: true, force: true })
      }
    }, 60_000)
  })

  describe('symbolic links, judged by where they really lead', () => {
    it('refuses chained links whose texts each look harmless', async () => {
      const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await symlink('.', path.join(workdir, 'here'))
      await symlink('here/..', path.join(workdir, 'escape'))
      await symlink('here/../../../../../../../../etc', path.join(workdir, 'far'))
      await expect(ws.commit(workdir, 'links')).rejects.toThrow(/outside the repository: escape, far$/)
      expect(await git(clone, 'rev-parse', 'rumba/hub/1')).toBe(baseSha)
    })

    it('refuses a link that leaves through a linked directory', async () => {
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'a/b/file.txt', 'x')
      await symlink('a/b', path.join(workdir, 'shortcut'))
      await symlink('shortcut/../../..', path.join(workdir, 'out'))
      await expect(ws.commit(workdir, 'links')).rejects.toThrow(/outside the repository: out$/)
    })

    it('refuses an absolute target, a loop, and a link added in an earlier commit that a later change redirects', async () => {
      const first = await ws.prepare('rumba/hub/1', { fresh: true })
      await symlink('/etc', path.join(first.workdir, 'config'))
      await symlink('loop', path.join(first.workdir, 'loop'))
      await expect(ws.commit(first.workdir, 'links')).rejects.toThrow(/outside the repository: config, loop$/)

      const second = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(second.workdir, 'deep/down/x', 'x')
      await symlink('deep/down', path.join(second.workdir, 'd'))
      await symlink('d/../..', path.join(second.workdir, 'up'))   // deep/down/../.. is the root: inside
      expect(await ws.commit(second.workdir, 'ok for now')).toMatch(/^[0-9a-f]{40}$/)
      await rm(path.join(second.workdir, 'd'))
      await mkdir(path.join(second.workdir, 'd'))                  // now d/../.. is above the root
      await write(second.workdir, 'd/keep', 'x')
      await expect(ws.commit(second.workdir, 'redirect')).rejects.toThrow(/outside the repository: up$/)
    })

    it('commits links that stay inside, also through other links', async () => {
      const { workdir, baseSha } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'docs/a.md', 'x')
      await symlink('docs', path.join(workdir, 'd'))
      await symlink('d/a.md', path.join(workdir, 'A.md'))
      await symlink('../README.md', path.join(workdir, 'docs/readme'))
      await symlink('d/../docs/missing.md', path.join(workdir, 'dangling'))
      expect(await ws.commit(workdir, 'links')).toMatch(/^[0-9a-f]{40}$/)
      expect((await ws.changedFiles(workdir, baseSha)).sort()).toEqual(['A.md', 'd', 'dangling', 'docs/a.md', 'docs/readme'])
    })

    it('leaves alone a link a person committed that points outside, but not a new link through it', async () => {
      await symlink('/usr/share', path.join(clone, 'shared'))
      await pushToMain('link')
      const { workdir } = await ws.prepare('rumba/hub/1', { fresh: true })
      await write(workdir, 'a.txt', 'x')
      expect(await ws.commit(workdir, 'work')).toMatch(/^[0-9a-f]{40}$/)
      await symlink('shared/dict', path.join(workdir, 'mine'))
      await expect(ws.commit(workdir, 'through')).rejects.toThrow(/outside the repository: mine$/)
    })
  })

  describe('the trusted checkout', () => {
    let trusted: string
    beforeEach(async () => {
      await write(clone, 'scripts/up.sh', '#!/bin/sh\necho trusted\n')
      await chmod(path.join(clone, 'scripts/up.sh'), 0o755)
      await write(clone, '.gitignore', '.env\n')
      await symlink('scripts/up.sh', path.join(clone, 'up'))
      await pushToMain('script')
      await ws.prepare('rumba/hub/1', { fresh: true })
      trusted = await ws.trustedCheckout('rumba/hub/1')
    })

    it('has a parent directory of its own, apart from every other checkout', async () => {
      const candidate = (await ws.prepare('rumba/hub/1', { fresh: false })).workdir
      const second = await ws.trustedCheckout('rumba/hub/1')
      const parents = [trusted, candidate, second].map((d) => path.dirname(d))
      expect(new Set(parents).size).toBe(3)
      for (const p of parents) expect(p).not.toBe(await realpath(tmpdir()))
      // Climbing out of a checkout reaches a folder that holds nothing but that checkout.
      expect(await readdir(path.dirname(candidate))).toEqual([path.basename(candidate)])
      await ws.cleanup(second)
      expect(existsSync(path.dirname(second))).toBe(false)
    })

    it('verifies while nothing has changed', async () => {
      await expect(ws.verifyTrusted(trusted)).resolves.toBeUndefined()
      await expect(ws.verifyTrusted(trusted)).resolves.toBeUndefined()
    })

    it.each([
      ['a file rewritten with the same length and times', async (t: string) => {
        const file = path.join(t, 'scripts/up.sh'); const before = await stat(file)
        await writeFile(file, '#!/bin/sh\necho AGENT!!\n'); await utimes(file, before.atime, before.mtime)
      }, /scripts\/up\.sh/],
      ['a new file that git ignores', async (t: string) => { await writeFile(path.join(t, '.env'), 'COMPOSE_FILE=/elsewhere.yml\n') }, /\.env/],
      ['a new folder', async (t: string) => { await mkdir(path.join(t, 'extra')) }, /extra/],
      ['a deleted file', async (t: string) => { await rm(path.join(t, 'README.md')) }, /README\.md/],
      ['a file made executable', async (t: string) => { await chmod(path.join(t, 'README.md'), 0o755) }, /README\.md/],
      ['a link pointed elsewhere', async (t: string) => { await rm(path.join(t, 'up')); await symlink('/bin/sh', path.join(t, 'up')) }, /up/],
      ['a file replaced by a link', async (t: string) => { await rm(path.join(t, 'README.md')); await symlink('scripts/up.sh', path.join(t, 'README.md')) }, /README\.md/],
      ['a replaced .git pointer', async (t: string) => { await rm(path.join(t, '.git')); await mkdir(path.join(t, '.git')) }, /\.git/],
    ])('refuses to verify after %s', async (_name, change, pattern) => {
      await change(trusted)
      await expect(ws.verifyTrusted(trusted)).rejects.toThrow(/no longer matches/)
      await expect(ws.verifyTrusted(trusted)).rejects.toThrow(pattern)
    })

    it('refuses a directory that is not one of its trusted checkouts', async () => {
      const candidate = (await ws.prepare('rumba/hub/1', { fresh: false })).workdir
      await expect(ws.verifyTrusted(candidate)).rejects.toThrow(/not a trusted checkout/)
    })

    it('forgets a trusted checkout once it is cleaned up', async () => {
      await ws.cleanup(trusted)
      expect(existsSync(trusted)).toBe(false)
      await expect(ws.verifyTrusted(trusted)).rejects.toThrow(/not a trusted checkout/)
    })
  })
})
