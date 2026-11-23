import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { lstat, mkdtemp, open, readdir, readFile, readlink, realpath, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import type { Workspace } from '../../ports/workspace.js'
import { removeTree } from './removeTree.js'
import { compareWithTree, type TreeEntry } from './treeCheck.js'
import { nestedGitEntries, resolveLink } from './untrustedTree.js'

const BOT_NAME = 'Rumba'
const BOT_EMAIL = 'rumba@users.noreply.github.com'
const OUTPUT_DIR = '.rumba-out'
/** The largest file readFileAt reads: more than any test file needs. */
const MAX_READ_BYTES = 1_000_000
/**
 * Config for every git process: no hook and no fsmonitor command ever runs, no attributes
 * file outside the repository is read, no command recurses into submodules, and files are
 * checked out byte for byte.
 */
const SAFE = [
  '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
  '-c', 'core.attributesFile=/dev/null', '-c', 'submodule.recurse=false',
]
/** Inherited variables that would point git at another repository, index or object store. */
export const LOCATION_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_ATTR_SOURCE']
/** The identity commits are made as when the workspace is given none. */
export const RUMBA_IDENTITY = { name: BOT_NAME, email: BOT_EMAIL }

function identityEnv(a: { name: string; email: string }): Record<string, string> {
  return { GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_COMMITTER_NAME: a.name, GIT_COMMITTER_EMAIL: a.email }
}
/**
 * For git commands that read or check out files an agent wrote: the user's and the system's
 * git config are not read, so no driver defined there applies to those files. These commands
 * name their git directory explicitly, so they need nothing from that config.
 */
const NO_HOST_CONFIG = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }

interface Worktree { branch: string; gitDir: string }
/** The branch recorded for a worktree that is on none; no real branch name is empty. */
const DETACHED = ''
/** A trusted checkout: its commit, that commit's tree, and the `.git` pointer git wrote in it. */
interface Trusted { sha: string; tree: Map<string, TreeEntry>; pointer: string }
/** What every git command is started with, found once from the trusted repository. */
interface Setup { commonDir: string; options: string[] }

/**
 * Worktrees of a trusted checkout, one per fix branch.
 *
 * An agent can write anything inside a workdir, and so can code in a container that has it
 * mounted. Host git is kept away from all of it:
 * - git never discovers a repository from a workdir: the worktree's git directory inside
 *   `repoRoot` is found from the trusted side and passed explicitly to every command;
 * - git never enters a repository an agent created: a workdir with a `.git` entry below its
 *   root is refused before any command that walks the files, and no gitlink is committed;
 * - git never reads a `.gitattributes` from a workdir or from a commit an agent made:
 *   attributes come from the empty tree, and no attributes file of the user is read;
 * - no filter driver runs at all: the commands that read or check out agent-written files
 *   do not read the user's or the system's config, and every filter driver the repository's
 *   own config defines is switched off for them, so the repository's `info/attributes`
 *   cannot select one either. Files are stored and checked out byte for byte;
 * - a workdir is removed by deleting it, not by a git command that inspects it, and with a
 *   deletion that cannot be led outside it by swapping a folder for a link.
 */
export class GitWorkspace implements Workspace {
  private readonly repoRoot: string
  private readonly defaultBranch: string
  private readonly remote: string
  /** Worktrees this instance created or adopted, by real workdir path. */
  private readonly worktrees = new Map<string, Worktree>()
  /** The default-branch commit each fix branch was started from by this instance. */
  private readonly bases = new Map<string, string>()
  /** Trusted checkouts this instance handed out, by real path. */
  private readonly trusted = new Map<string, Trusted>()
  private setup: Promise<Setup> | undefined

  /** Who commits are made as; asked once, on the first commit. */
  private readonly author: () => Promise<{ name: string; email: string }>
  private authorOnce: Promise<{ name: string; email: string }> | undefined

  constructor(o: { repoRoot: string; defaultBranch: string; remote?: string; author?: () => Promise<{ name: string; email: string }> }) {
    this.repoRoot = o.repoRoot
    this.defaultBranch = o.defaultBranch
    this.remote = o.remote ?? 'origin'
    this.author = o.author ?? (async () => RUMBA_IDENTITY)
  }

  async prepare(branch: string, opts: { fresh: boolean; like?: string }): Promise<{ workdir: string; baseSha: string }> {
    return opts.fresh ? this.prepareFresh(branch, opts.like) : this.prepareExisting(branch)
  }

  private async prepareFresh(branch: string, like?: string): Promise<{ workdir: string; baseSha: string }> {
    let baseSha: string
    if (like === undefined) {
      await this.git(['fetch', '-q', this.remote, this.defaultBranch])
      baseSha = await this.git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])
    } else {
      if (!(await this.branchExists(like))) throw new Error(`Branch ${like} does not exist in ${this.repoRoot}`)
      baseSha = this.bases.get(like) ?? (await this.forkPoint(like))
    }
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
    const sha = this.bases.get(branch) ?? (await this.forkPoint(branch))
    const dir = await this.addWorktree(['--detach'], sha, DETACHED)
    this.trusted.set(dir, { sha, tree: await this.treeOf(sha), pointer: await readFile(path.join(dir, '.git'), 'utf8') })
    return dir
  }

  /**
   * Throws unless the trusted checkout still holds exactly its commit: every file and link
   * with the content git stored, nothing added, nothing missing. Called before each command
   * that runs there, because code in a container could have been given the folder.
   */
  async verifyTrusted(dir: string): Promise<void> {
    const real = await realpath(dir).catch(() => path.resolve(dir))
    const t = this.trusted.get(real)
    if (!t) throw new Error(`${dir} is not a trusted checkout of ${this.repoRoot}`)
    const changed = await compareWithTree(real, t.tree, t.pointer)
    if (changed.length === 0) return
    const shown = changed.slice(0, 5).join(', ') + (changed.length > 5 ? `, and ${changed.length - 5} more` : '')
    throw new Error(
      `The trusted checkout ${real} no longer matches its commit ${t.sha.slice(0, 12)}: ${shown}. ` +
      'A command on the host must not write into the folder it runs in, and no container may be given that folder to write to.',
    )
  }

  private forkPoint(branch: string): Promise<string> {
    return this.git(['merge-base', `refs/heads/${branch}`, `refs/remotes/${this.remote}/${this.defaultBranch}`])
  }

  /**
   * Adds a worktree and records its git directory before any agent can touch it. Each
   * worktree sits alone in a new temp folder named like it, so climbing out of one, through
   * `..` or a link, reaches a folder that holds nothing else.
   */
  private async addWorktree(flags: string[], start: string, branch: string): Promise<string> {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-')))
    const workdir = path.join(parent, path.basename(parent))
    try {
      // The checkout may be of a commit an agent made. The git directory is named explicitly,
      // so this needs no discovery and nothing from the user's or the system's config.
      const { commonDir } = await this.started()
      await this.run(['--git-dir', commonDir, ...SAFE, 'worktree', 'add', '-q', ...flags, workdir, start], this.repoRoot, [0], NO_HOST_CONFIG)
      this.worktrees.set(workdir, { branch, gitDir: await this.findGitDir(workdir) })
    } catch (e) {
      await removeTree(workdir).catch(() => undefined)
      await removeOwnParent(workdir)
      throw e
    }
    return workdir
  }

  async commit(workdir: string, message: string, opts: { allowEmpty?: boolean } = {}): Promise<string | null> {
    const wt = await this.worktree(workdir)
    await this.refuseNestedRepositories(workdir)
    await this.inWorktree(wt, workdir, ['add', '-A', '--', '.', `:(top,exclude)${OUTPUT_DIR}`])
    const staged = await this.inWorktree(wt, workdir, ['diff', '--cached', '--quiet', '--no-ext-diff'], [0, 1])
    if (staged.exitCode === 0 && opts.allowEmpty !== true) return null
    await this.refuseLinksOut(wt, workdir)
    const empty = opts.allowEmpty === true ? ['--allow-empty'] : []
    this.authorOnce ??= this.author().catch(() => RUMBA_IDENTITY)
    const author = await this.authorOnce
    await this.inWorktree(wt, workdir, ['-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', ...empty, '-m', message], [0], identityEnv(author))
    return (await this.inWorktree(wt, workdir, ['rev-parse', '--verify', 'HEAD'])).stdout
  }

  /**
   * git enters a nested repository to see whether it changed, reading that repository's own
   * config and running the filter drivers it defines. So a workdir holding one is refused
   * before any git command walks its files.
   */
  private async refuseNestedRepositories(workdir: string): Promise<void> {
    const found = await nestedGitEntries(workdir)
    if (found.length === 0) return
    throw new Error(`Refusing to run git in ${workdir}: the agent created a git repository inside it (${found.join(', ')}).`)
  }

  /**
   * Refuses what is staged if it holds a gitlink the base commit does not have, or a symbolic
   * link that leads outside the repository. Docker follows a link on the host when a path
   * below the checkout is mounted or used as a build context, so a link is judged by where
   * it really leads in this worktree, through every link on the way, not by its text. Every
   * link in the tree is judged at every commit, because changing a folder elsewhere can
   * redirect an old link. A link a person committed that plainly points outside is theirs to
   * keep; a link an agent adds may not go through it.
   */
  private async refuseLinksOut(wt: Worktree, workdir: string): Promise<void> {
    const base = await this.treeOf(this.bases.get(wt.branch) ?? (await this.inWorktree(wt, workdir, ['merge-base', 'HEAD', `refs/remotes/${this.remote}/${this.defaultBranch}`])).stdout)
    const index = new Map<string, TreeEntry>()
    for (const record of (await this.inWorktree(wt, workdir, ['ls-files', '-s', '-z'])).stdout.split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, oid] = record.slice(0, tab).split(' ')
      index.set(record.slice(tab + 1), { mode, oid })
    }
    const unchanged = (file: string) => base.get(file)?.mode === index.get(file)?.mode && base.get(file)?.oid === index.get(file)?.oid

    const gitlinks = [...index].filter(([file, e]) => e.mode === '160000' && !unchanged(file)).map(([file]) => file)
    if (gitlinks.length > 0) throw new Error(`Refusing to commit a git repository inside the repository: ${gitlinks.join(', ')}`)

    const links = [...index].filter(([, e]) => e.mode === '120000').map(([file]) => file)
    const texts = new Map<string, string>()
    for (const file of links) texts.set(file, await readlink(path.join(workdir, file)).catch(() => '/'))
    /** A link a person committed whose own text points outside: absolute, or climbing above the root. */
    const personOut = (file: string) => {
      const text = texts.get(file)
      if (text === undefined || !unchanged(file)) return false
      const lexical = path.posix.normalize(path.posix.join(path.posix.dirname(file), text))
      return path.posix.isAbsolute(text) || lexical === '..' || lexical.startsWith('../')
    }
    const out: string[] = []
    for (const file of links) {
      if (personOut(file)) continue
      const leads = await resolveLink(workdir, file, personOut)
      if (leads === 'inside' || (leads === 'person' && unchanged(file))) continue
      out.push(file)
    }
    if (out.length > 0) throw new Error(`Refusing to commit symbolic links that lead outside the repository: ${out.join(', ')}`)
  }

  async head(workdir: string): Promise<string> {
    const wt = await this.worktree(workdir)
    return (await this.inWorktree(wt, workdir, ['rev-parse', '--verify', 'HEAD'])).stdout.trim()
  }

  async reset(workdir: string, sha: string): Promise<void> {
    const wt = await this.worktree(workdir)
    await this.refuseNestedRepositories(workdir)
    await this.inWorktree(wt, workdir, ['reset', '-q', '--hard', sha])
    await this.inWorktree(wt, workdir, ['clean', '-q', '-ffdx'])
  }

  async changedFiles(workdir: string, sinceSha: string): Promise<string[]> {
    const wt = await this.worktree(workdir)
    const out = (await this.inWorktree(wt, workdir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', '--no-ext-diff', '--no-renames', sinceSha, 'HEAD'])).stdout
    return out.split('\0').filter((p) => p !== '')
  }

  async diff(workdir: string, sinceSha: string, maxChars: number): Promise<string> {
    const wt = await this.worktree(workdir)
    // --no-ext-diff and --no-textconv: a diff must never run a program the repository names.
    const text = (await this.inWorktree(wt, workdir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', sinceSha, 'HEAD'])).stdout
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[diff cut at ${maxChars} characters]`
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

  async readFileAt(_workdir: string, sha: string, file: string): Promise<string | null> {
    const entry = await this.entryAt(sha, file)
    if (entry === null || (entry.mode !== '100644' && entry.mode !== '100755')) return null
    const size = Number((await this.git(['cat-file', '-s', entry.oid])).trim())
    if (size > MAX_READ_BYTES) throw new Error(`${file} is too large to read (${size} bytes)`)
    const text = (await this.gitResult(['cat-file', 'blob', entry.oid], [0], { strip: false })).stdout
    // Bytes that are not UTF-8 read as U+FFFD, and two different files must never read as the same text.
    if (text.includes('\uFFFD')) throw new Error(`${file} is not UTF-8 text`)
    return text
  }

  async checkoutFiles(workdir: string, sha: string, files: string[]): Promise<void> {
    const wt = await this.worktree(workdir)
    const present: string[] = []
    const absent: string[] = []
    for (const file of files) ((await this.entryAt(sha, file)) === null ? absent : present).push(file)
    if (present.length > 0) await this.inWorktree(wt, workdir, ['--literal-pathspecs', 'checkout', '-q', sha, '--', ...present])
    if (absent.length > 0) await this.inWorktree(wt, workdir, ['--literal-pathspecs', 'rm', '-q', '-f', '--ignore-unmatch', '--', ...absent])
  }

  /** The tree entry of one path in a commit, read from the trusted repository's objects. */
  private async entryAt(sha: string, file: string): Promise<TreeEntry | null> {
    const out = (await this.gitResult(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', sha, '--', file], [0], { strip: false })).stdout
    for (const record of out.split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0 || record.slice(tab + 1) !== file) continue
      const [mode, , oid] = record.slice(0, tab).split(' ')
      return { mode: mode!, oid: oid! }
    }
    return null
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
   * the main checkout included, unless it is already gone. The directory is deleted, not
   * handed to `git worktree remove`: an agent or a container wrote to it, and no git command
   * should inspect it. Something may even still be writing to it (a container that did not
   * stop), so it is deleted by a walk that cannot be led outside it (see removeTree). When it cannot be deleted (files owned by another user, say), its
   * registration is dropped on the trusted side so the branch is free again, and the
   * directory is left behind.
   */
  private async removeWorktree(real: string): Promise<void> {
    this.worktrees.delete(real)
    this.trusted.delete(real)
    if (existsSync(real)) {
      const gitDir = await this.findGitDir(real)
      try {
        await removeTree(real)
      } catch {
        await rm(gitDir, { recursive: true, force: true })
      }
    }
    await removeOwnParent(real)
    await this.git(['worktree', 'prune'])
  }

  async cleanupAll(): Promise<void> {
    for (const dir of [...this.worktrees.keys()]) {
      // Never throws: it runs in the engine's finally. A worktree left behind is pruned by a later prepare.
      await this.cleanup(dir).catch(() => undefined)
    }
    this.trusted.clear()
  }

  /** The recorded worktree for `workdir`, or one registered in `repoRoot` with the same real path. */
  private async worktree(workdir: string): Promise<Worktree> {
    const real = await realpath(workdir).catch(() => path.resolve(workdir))
    return this.worktrees.get(real) ?? { branch: DETACHED, gitDir: await this.findGitDir(real) }
  }

  /**
   * The git directory `repoRoot` keeps for the worktree at `workdir`, read from the
   * `worktrees/<id>/gitdir` files of the trusted checkout, never from the workdir.
   */
  private async findGitDir(workdir: string): Promise<string> {
    const want = await realpath(workdir).catch(() => path.resolve(workdir))
    const base = path.join((await this.started()).commonDir, 'worktrees')
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

  /** Every file, link and gitlink of a commit, by path, read from the trusted repository's objects. */
  private async treeOf(sha: string): Promise<Map<string, TreeEntry>> {
    const tree = new Map<string, TreeEntry>()
    for (const record of (await this.git(['ls-tree', '-r', '-z', '--full-tree', sha])).split('\0')) {
      const tab = record.indexOf('\t')
      if (tab < 0) continue
      const [mode, , oid] = record.slice(0, tab).split(' ')
      tree.set(record.slice(tab + 1), { mode, oid })
    }
    return tree
  }

  /**
   * Runs git on one worktree with its git directory and work tree given explicitly, and
   * without the user's or the system's git config.
   */
  private async inWorktree(wt: Worktree, workdir: string, args: string[], ok: number[] = [0], env: Record<string, string> = {}) {
    return this.run(['--git-dir', wt.gitDir, '--work-tree', workdir, ...SAFE, ...args], workdir, ok, { ...NO_HOST_CONFIG, ...env })
  }

  /** Runs git in the trusted checkout and returns its trimmed output. */
  private async git(args: string[]): Promise<string> {
    return (await this.gitResult(args)).stdout
  }

  private async gitResult(args: string[], ok: number[] = [0], o: { strip?: boolean } = {}) {
    return this.run([...SAFE, ...args], this.repoRoot, ok, {}, o)
  }

  /**
   * Every git command takes its attributes from the empty tree, so a `.gitattributes` in a
   * workdir or in a commit is never read, and has every filter driver of the repository's
   * own config switched off. A git too old to know `--attr-source` fails here instead of
   * running without it.
   */
  private async run(args: string[], cwd: string, ok: number[], env: Record<string, string> = {}, o: { strip?: boolean } = {}) {
    return this.spawnGit([...(await this.started()).options, ...args], cwd, ok, env, o)
  }

  private started(): Promise<Setup> {
    this.setup ??= this.findSetup().catch((e: unknown) => {
      this.setup = undefined
      throw e
    })
    return this.setup
  }

  private async findSetup(): Promise<Setup> {
    const emptyTree = (await this.spawnGit(['hash-object', '-t', 'tree', '/dev/null'], this.repoRoot, [0], {})).stdout.trim()
    const commonDir = (await this.spawnGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], this.repoRoot, [0], {})).stdout.trim()
    // The filter drivers that are left once the user's and the system's config are not read:
    // those of the repository's own config, and of anything it includes.
    const listed = await this.spawnGit(['--git-dir', commonDir, 'config', '--name-only', '-z', '--get-regexp', '^filter\\.'], this.repoRoot, [0, 1], NO_HOST_CONFIG)
    const drivers = new Set<string>()
    for (const key of listed.stdout.split('\0')) {
      const name = key.slice('filter.'.length, key.lastIndexOf('.'))
      if (key.startsWith('filter.') && key.lastIndexOf('.') > 'filter'.length) drivers.add(name)
    }
    const off: string[] = []
    for (const name of drivers) {
      if (/[=\n]/.test(name)) throw new Error(`Cannot switch off the git filter driver "${name}" of ${this.repoRoot}: its name holds "=" or a line break.`)
      for (const setting of ['clean=', 'smudge=', 'process=', 'required=false']) off.push('-c', `filter.${name}.${setting}`)
    }
    return { commonDir, options: [`--attr-source=${emptyTree}`, ...off] }
  }

  /** Starts git with an argument array; no shell is involved. */
  /**
   * Git runs with a umask of 022, whatever the caller's is, so the files it checks out can be
   * read by a project image that runs as another user. The worktree's parent folder stays
   * private (mode 700). `sh` only sets the umask and then replaces itself with git; the
   * arguments are passed as "$@", never as shell text.
   */
  private async spawnGit(args: string[], cwd: string, ok: number[], env: Record<string, string>, o: { strip?: boolean } = {}) {
    const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !LOCATION_VARS.includes(k)))
    const result = await execa('/bin/sh', ['-c', 'umask 022 && exec git "$@"', 'git', ...args], {
      cwd, stdin: 'ignore', all: true, reject: false, extendEnv: false, env: { ...base, ...env, GIT_TERMINAL_PROMPT: '0' },
      stripFinalNewline: o.strip ?? true,
    })
    if (!ok.includes(result.exitCode ?? -1)) throw new Error(`git ${args.join(' ')} failed:\n${result.all ?? ''}`)
    return result
  }
}

/** Removes the private temp folder a worktree sat in, when it is one and it is now empty. */
async function removeOwnParent(workdir: string): Promise<void> {
  const parent = path.dirname(workdir)
  if (path.basename(parent) === path.basename(workdir)) await rmdir(parent).catch(() => undefined)
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
