import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdtemp, open, readdir, readFile, readlink, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import type { Workspace } from '../../ports/workspace.js'

const BOT_NAME = 'Rumba'
const BOT_EMAIL = 'rumba@users.noreply.github.com'
const OUTPUT_DIR = '.rumba-out'
/** Config for every git process: no hook and no fsmonitor command ever runs. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']
/** Inherited variables that would point git at another repository, index or object store. */
const LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']
const BOT_ENV = { GIT_AUTHOR_NAME: BOT_NAME, GIT_AUTHOR_EMAIL: BOT_EMAIL, GIT_COMMITTER_NAME: BOT_NAME, GIT_COMMITTER_EMAIL: BOT_EMAIL }

interface Worktree { branch: string; gitDir: string }
/** The branch recorded for a worktree that is on none; no real branch name is empty. */
const DETACHED = ''

/**
 * Worktrees of a trusted checkout, one per fix branch.
 *
 * The agent can write anything inside a workdir, including its .git pointer, so git never
 * discovers a repository from a workdir. The worktree's git directory inside `repoRoot` is
 * found from the trusted side and passed explicitly to every git command for that workdir.
 */
export class GitWorkspace implements Workspace {
  private readonly repoRoot: string
  private readonly defaultBranch: string
  private readonly remote: string
  /** Worktrees this instance created or adopted, by real workdir path. */
  private readonly worktrees = new Map<string, Worktree>()
  /** The default-branch commit each fix branch was started from by this instance. */
  private readonly bases = new Map<string, string>()

  constructor(o: { repoRoot: string; defaultBranch: string; remote?: string }) {
    this.repoRoot = o.repoRoot
    this.defaultBranch = o.defaultBranch
    this.remote = o.remote ?? 'origin'
  }

  async prepare(branch: string, opts: { fresh: boolean }): Promise<{ workdir: string; baseSha: string }> {
    return opts.fresh ? this.prepareFresh(branch) : this.prepareExisting(branch)
  }

  private async prepareFresh(branch: string): Promise<{ workdir: string; baseSha: string }> {
    await this.git(['fetch', '-q', this.remote, this.defaultBranch])
    const baseSha = await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    await this.git(['worktree', 'prune'])
    for (const dir of await this.registered(branch)) await this.removeWorktree(dir)
    if (await this.branchExists(branch)) await this.git(['branch', '-D', branch])
    const workdir = await this.addWorktree(['-b', branch], baseSha, branch)
    this.bases.set(branch, baseSha)
    return { workdir, baseSha }
  }

  private async prepareExisting(branch: string): Promise<{ workdir: string; baseSha: string }> {
    if (!(await this.branchExists(branch))) throw new Error(`Branch ${branch} does not exist in ${this.repoRoot}`)
    let workdir = [...this.worktrees].find(([dir, wt]) => wt.branch === branch && existsSync(dir))?.[0]
    if (!workdir) {
      await this.git(['worktree', 'prune'])
      const found = (await this.registered(branch))[0]
      if (found) {
        this.worktrees.set(found, { branch, gitDir: await this.findGitDir(found) })
        workdir = found
      } else {
        workdir = await this.addWorktree([], branch, branch)
      }
    }
    return { workdir, baseSha: await this.forkPoint(branch) }
  }

  /**
   * A new checkout, on no branch, of the default-branch commit that `branch` started from:
   * code a person merged, with nothing in it that an agent wrote. Commands that run on the
   * host use it as their working directory. The commit is the one this instance fetched when
   * it created the branch, or else the branch's merge base with the remote default branch;
   * either way it is found from the trusted repository, never from a workdir.
   */
  async trustedCheckout(branch: string): Promise<string> {
    if (!(await this.branchExists(branch))) throw new Error(`Branch ${branch} does not exist in ${this.repoRoot}`)
    const base = this.bases.get(branch) ?? (await this.forkPoint(branch))
    return this.addWorktree(['--detach'], base, DETACHED)
  }

  private forkPoint(branch: string): Promise<string> {
    return this.git(['merge-base', `refs/heads/${branch}`, `refs/remotes/${this.remote}/${this.defaultBranch}`])
  }

  /** Adds a worktree in a new temp dir and records its git directory before any agent can touch it. */
  private async addWorktree(flags: string[], start: string, branch: string): Promise<string> {
    const workdir = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-')))
    try {
      await this.git(['worktree', 'add', '-q', ...flags, workdir, start])
      this.worktrees.set(workdir, { branch, gitDir: await this.findGitDir(workdir) })
    } catch (e) {
      await rm(workdir, { recursive: true, force: true })
      throw e
    }
    return workdir
  }

  async commit(workdir: string, message: string, opts: { allowEmpty?: boolean } = {}): Promise<string | null> {
    const wt = await this.worktree(workdir)
    await this.inWorktree(wt, workdir, ['add', '-A', '--', '.', `:(top,exclude)${OUTPUT_DIR}`])
    const staged = await this.inWorktree(wt, workdir, ['diff', '--cached', '--quiet', '--no-ext-diff'], [0, 1])
    if (staged.exitCode === 0 && opts.allowEmpty !== true) return null
    const links = await this.stagedLinksOut(wt, workdir)
    if (links.length > 0) throw new Error(`Refusing to commit symbolic links that point outside the repository: ${links.join(', ')}`)
    const empty = opts.allowEmpty === true ? ['--allow-empty'] : []
    await this.inWorktree(wt, workdir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', ...empty, '-m', message], [0], BOT_ENV)
    return (await this.inWorktree(wt, workdir, ['rev-parse', '--verify', 'HEAD'])).stdout
  }

  /**
   * Symbolic links this commit would add or change whose target is absolute or climbs out of
   * the repository. Docker follows such a link on the host when a path below the checkout is
   * mounted or used as a build context, so Rumba never puts one in a commit it brings up.
   */
  private async stagedLinksOut(wt: Worktree, workdir: string): Promise<string[]> {
    const raw = (await this.inWorktree(wt, workdir, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff'])).stdout
    const fields = raw.split('\0')
    const out: string[] = []
    // Each entry is ":<old mode> <new mode> <old sha> <new sha> <status>" followed by its path.
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [, mode, , sha] = fields[i].split(' ')
      if (mode !== '120000') continue
      const file = fields[i + 1]
      const target = (await this.inWorktree(wt, workdir, ['cat-file', 'blob', sha])).stdout
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target))
      if (path.posix.isAbsolute(target) || resolved === '..' || resolved.startsWith('../')) out.push(file)
    }
    return out
  }

  async reset(workdir: string, sha: string): Promise<void> {
    const wt = await this.worktree(workdir)
    await this.inWorktree(wt, workdir, ['reset', '-q', '--hard', sha])
    await this.inWorktree(wt, workdir, ['clean', '-q', '-ffdx'])
  }

  async changedFiles(workdir: string, sinceSha: string): Promise<string[]> {
    const wt = await this.worktree(workdir)
    const out = (await this.inWorktree(wt, workdir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', sinceSha, 'HEAD'])).stdout
    return out.split('\0').filter((p) => p !== '')
  }

  async hashFiles(workdir: string, files: string[]): Promise<Record<string, string>> {
    const root = await realpath(workdir)
    const hashes: Record<string, string> = {}
    for (const file of files) {
      const full = path.resolve(root, file)
      if (!inside(root, full)) throw new Error(`${file} is outside the workdir`)
      let content: Buffer
      try {
        // Resolve the directories on the way, not the file itself: a link is hashed, never followed.
        const target = path.join(await realpath(path.dirname(full)), path.basename(full))
        if (!inside(root, target)) throw new Error(`${file} resolves outside the workdir`)
        content = await readRegularOrLink(target, file)
      } catch (e) {
        if (missing(e)) continue
        throw e
      }
      hashes[file] = createHash('sha256').update(content).digest('hex')
    }
    return hashes
  }

  /** Never throws. A directory that is not one of repoRoot's worktrees is left alone. */
  async cleanup(workdir: string): Promise<void> {
    try {
      await this.removeWorktree(await realpath(workdir).catch(() => path.resolve(workdir)))
    } catch {
      // A worktree left behind is pruned or replaced by a later prepare.
    }
  }

  /**
   * Removes a linked worktree of repoRoot, leaving its branch. Refuses any other directory,
   * the main checkout included, unless it is already gone. When the directory cannot be
   * deleted (files owned by another user, say), its registration is dropped on the trusted
   * side so the branch is free again, and the directory is left behind.
   */
  private async removeWorktree(real: string): Promise<void> {
    this.worktrees.delete(real)
    if (existsSync(real)) {
      const gitDir = await this.findGitDir(real)
      // git refuses a worktree whose .git pointer the agent replaced; it is still a registered worktree.
      const removed = await this.gitResult(['worktree', 'remove', '--force', real], [0, 128]).catch(() => null)
      if (removed === null || removed.exitCode !== 0) {
        try {
          await rm(real, { recursive: true, force: true })
        } catch {
          await rm(gitDir, { recursive: true, force: true })
        }
      }
    }
    await this.git(['worktree', 'prune'])
  }

  async cleanupAll(): Promise<void> {
    for (const dir of [...this.worktrees.keys()]) {
      // Never throws: it runs in the engine's finally. A worktree left behind is pruned by a later prepare.
      await this.cleanup(dir).catch(() => undefined)
    }
  }

  /** The recorded worktree for `workdir`, or one registered in `repoRoot` with the same real path. */
  private async worktree(workdir: string): Promise<Worktree> {
    const real = await realpath(workdir).catch(() => path.resolve(workdir))
    return this.worktrees.get(real) ?? { branch: '', gitDir: await this.findGitDir(real) }
  }

  /**
   * The git directory `repoRoot` keeps for the worktree at `workdir`, read from the
   * `worktrees/<id>/gitdir` files of the trusted checkout, never from the workdir.
   */
  private async findGitDir(workdir: string): Promise<string> {
    const want = await realpath(workdir).catch(() => path.resolve(workdir))
    const common = await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    const base = path.join(common, 'worktrees')
    const ids = await readdir(base).catch(() => [] as string[])
    for (const id of ids) {
      const pointer = (await readFile(path.join(base, id, 'gitdir'), 'utf8').catch(() => '')).trim()
      if (!pointer) continue
      const dir = await realpath(path.dirname(pointer)).catch(() => null)
      if (dir === want) return path.join(base, id)
    }
    throw new Error(`${workdir} is not a worktree of ${this.repoRoot}`)
  }

  /** Real paths of the worktrees `repoRoot` has registered for `branch`. */
  private async registered(branch: string): Promise<string[]> {
    // -z: each field ends in NUL and each entry in an extra NUL, so no path is quoted or split.
    const fields = (await this.git(['worktree', 'list', '--porcelain', '-z'])).split('\0')
    const dirs: string[] = []
    let entry: string[] = []
    for (const field of fields) {
      if (field !== '') {
        entry.push(field)
        continue
      }
      const dir = entry.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
      if (dir !== undefined && entry.includes(`branch refs/heads/${branch}`)) dirs.push(await realpath(dir).catch(() => dir))
      entry = []
    }
    return dirs
  }

  private async branchExists(branch: string): Promise<boolean> {
    return (await this.gitResult(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])).exitCode === 0
  }

  /** Runs git on one worktree with its git directory and work tree given explicitly. */
  private async inWorktree(wt: Worktree, workdir: string, args: string[], ok: number[] = [0], env: Record<string, string> = {}) {
    return this.run(['--git-dir', wt.gitDir, '--work-tree', workdir, ...SAFE, ...args], workdir, ok, env)
  }

  /** Runs git in the trusted checkout and returns its trimmed output. */
  private async git(args: string[]): Promise<string> {
    return (await this.gitResult(args)).stdout
  }

  private async gitResult(args: string[], ok: number[] = [0]) {
    return this.run([...SAFE, ...args], this.repoRoot, ok)
  }

  private async run(args: string[], cwd: string, ok: number[], env: Record<string, string> = {}) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !LOCATION_VARS.includes(k)))
    const result = await execa('git', args, {
      cwd, stdin: 'ignore', all: true, reject: false, extendEnv: false, env: { ...base, ...env, GIT_TERMINAL_PROMPT: '0' },
    })
    if (!ok.includes(result.exitCode ?? -1)) throw new Error(`git ${args.join(' ')} failed:\n${result.all ?? ''}`)
    return result
  }
}

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * The bytes of a regular file, or the target string of a symbolic link, read through one
 * handle opened without following a link or blocking, so the path cannot change in between.
 */
async function readRegularOrLink(target: string, file: string): Promise<Buffer> {
  let handle
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP' && (await lstat(target)).isSymbolicLink()) return Buffer.from(await readlink(target))
    if (missing(e)) throw e
    throw new Error(`${file} could not be opened: ${(e as Error).message}`)
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`${file} is not a regular file`)
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

function missing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}
