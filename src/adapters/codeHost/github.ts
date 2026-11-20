import { realpath } from 'node:fs/promises'
import type { Octokit } from '@octokit/rest'
import { execa } from 'execa'
import { cleanOutput } from '../../core/redact.js'
import type { CodeHost, PullRequestDraft } from '../../ports/codeHost.js'

const HEADER_KEY = 'http.https://github.com/.extraheader'

function httpStatus(e: unknown): number | undefined {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Git config for one git process, passed through its environment so the token is never
 * on the command line or in a config file. The empty header first clears one that
 * actions/checkout may have stored, which would otherwise be sent as well.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
  return {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: HEADER_KEY,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: HEADER_KEY,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    GIT_CONFIG_KEY_2: 'core.hooksPath',
    GIT_CONFIG_VALUE_2: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

export class GitHubCodeHost implements CodeHost {
  private readonly octokit: Octokit
  private readonly owner: string
  private readonly repo: string
  private readonly token: string
  private readonly repoRoot: string
  private readonly remoteUrl: string

  /**
   * `repoRoot` is the trusted main checkout the worktrees belong to. The agent can write to a
   * worktree, including its .git pointer, so no git command runs in or reads metadata from one.
   */
  constructor(o: { octokit: Octokit; owner: string; repo: string; token: string; repoRoot: string; remoteUrl?: string }) {
    this.octokit = o.octokit
    this.owner = o.owner
    this.repo = o.repo
    this.token = o.token
    this.repoRoot = o.repoRoot
    this.remoteUrl = o.remoteUrl ?? `https://github.com/${o.owner}/${o.repo}.git`
  }

  async defaultBranch(): Promise<string> {
    const { data } = await this.octokit.rest.repos.get(this.where())
    return data.default_branch
  }

  async pushBranch(workdir: string, branch: string, opts: { force?: boolean } = {}): Promise<void> {
    const head = await this.worktreeHead(workdir)
    const ref = `refs/heads/${branch}`
    const args = ['push']
    if (opts.force) {
      // --force-with-lease needs a tracking ref to compare against; read the remote branch instead.
      const listed = await this.git(['ls-remote', this.remoteUrl, ref])
      const sha = listed.split('\n').find((l) => l.endsWith(`\t${ref}`))?.split('\t')[0]
      if (sha) args.push(`--force-with-lease=${ref}:${sha}`)
    }
    await this.git([...args, this.remoteUrl, `${head}:${ref}`])
  }

  /** The HEAD commit of `workdir`, as the trusted checkout records it for that worktree. */
  private async worktreeHead(workdir: string): Promise<string> {
    const want = await realpath(workdir)
    const listed = await this.git(['worktree', 'list', '--porcelain'])
    for (const entry of listed.split(/\n\n+/)) {
      const fields = new Map(entry.split('\n').map((l) => {
        const i = l.indexOf(' ')
        return i < 0 ? [l, ''] : [l.slice(0, i), l.slice(i + 1)]
      }))
      const dir = fields.get('worktree')
      const head = fields.get('HEAD')
      if (dir === undefined || head === undefined) continue
      const real = await realpath(dir).catch(() => null)
      if (real === want) return head
    }
    throw new Error(`${workdir} is not a worktree of ${this.repoRoot}`)
  }

  async deleteBranch(branch: string): Promise<void> {
    try {
      await this.octokit.rest.git.deleteRef({ ...this.where(), ref: `heads/${branch}` })
    } catch (e) {
      const status = httpStatus(e)
      // The branch is already gone.
      if (status !== 404 && status !== 422) throw e
    }
  }

  async openPullRequest(pr: PullRequestDraft): Promise<string> {
    try {
      const { data } = await this.octokit.rest.pulls.create({ ...this.where(), ...pr })
      return data.html_url
    } catch (e) {
      if (httpStatus(e) !== 422) throw e
      // A retry can find the pull request already open for this head.
      const { data } = await this.octokit.rest.pulls.list({ ...this.where(), state: 'open', head: `${this.owner}:${pr.head}` })
      const open = data[0]
      if (!open) throw e
      await this.octokit.rest.pulls.update({ ...this.where(), pull_number: open.number, title: pr.title, body: pr.body })
      return open.html_url
    }
  }

  private where(): { owner: string; repo: string } {
    return { owner: this.owner, repo: this.repo }
  }

  /** Runs git in the trusted checkout with the token in its environment; any error has the token removed. */
  private async git(args: string[]): Promise<string> {
    const result = await execa('git', args, { cwd: this.repoRoot, env: gitAuthEnv(this.token), all: true, reject: false, stdin: 'ignore' })
    if (result.exitCode !== 0) {
      const secrets = [this.token, `x-access-token:${this.token}`]
      throw new Error(cleanOutput(`git ${args[0]} failed:\n${result.all ?? ''}`, secrets))
    }
    return result.stdout
  }
}
