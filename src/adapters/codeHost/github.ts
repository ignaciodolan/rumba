import { realpath } from 'node:fs/promises'
import type { Octokit } from '@octokit/rest'
import { execa } from 'execa'
import { isOwnReply, withMarker } from '../../core/marker.js'
import { cleanOutput } from '../../core/redact.js'
import { CodeHostIdentityError, type CodeHost, FeedbackItem, LabelAdded, PullRequestDraft, PullRequestInfo } from '../../ports/codeHost.js'

const PER_PAGE = 100

const UNKNOWN_LOGIN =
  'Could not determine which GitHub account Rumba runs as. Set RUMBA_GITHUB_LOGIN to its login (for the GitHub Actions token: github-actions[bot]).'

const WRITE_ROLES = new Set(['admin', 'maintain', 'write'])

const REVIEW_STATES: Record<string, NonNullable<FeedbackItem['reviewState']>> = {
  CHANGES_REQUESTED: 'changes_requested',
  APPROVED: 'approved',
  COMMENTED: 'commented',
}

type Author = { login: string; type: string } | null

/**
 * Rumba's own: a comment by the account Rumba runs as whose first line is the marker, or which opens like a reply
 * Rumba posted before the marker existed. That account may be a maintainer's, so the author alone is not enough.
 * Rumba writes no reviews or line comments, so those are a person's.
 */
function isOwn(i: Pick<FeedbackItem, 'kind' | 'author' | 'text'>, self: string): boolean {
  return i.kind === 'comment' && i.author.toLowerCase() === self && isOwnReply(i.text)
}

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
  private readonly login: string | undefined

  /**
   * `repoRoot` is the trusted main checkout the worktrees belong to. The agent can write to a
   * worktree, including its .git pointer, so no git command runs in or reads metadata from one.
   */
  constructor(o: { octokit: Octokit; owner: string; repo: string; token: string; repoRoot: string; remoteUrl?: string; login?: string }) {
    this.octokit = o.octokit
    this.owner = o.owner
    this.repo = o.repo
    this.token = o.token
    this.repoRoot = o.repoRoot
    this.login = o.login
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

  async openPullRequest(draft: PullRequestDraft): Promise<string> {
    const pr = { ...draft, body: withMarker(draft.body) }
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

  async getPullRequest(url: string): Promise<PullRequestInfo> {
    const { data } = await this.octokit.rest.pulls.get({ ...this.where(), pull_number: this.pullNumber(url) })
    const info: PullRequestInfo = { state: data.merged || data.merged_at ? 'merged' : data.state === 'closed' ? 'closed' : 'open', headSha: data.head.sha, labels: data.labels.map((l) => l.name) }
    if (info.state === 'merged' && data.merged_at) info.mergedAt = data.merged_at
    if (info.state === 'closed' && data.closed_at) info.closedAt = data.closed_at
    return info
  }

  async listFeedback(url: string, since: string): Promise<FeedbackItem[]> {
    const number = this.pullNumber(url)
    const self = (await this.ownLogin()).toLowerCase()
    const target = { ...this.where(), per_page: PER_PAGE }
    const [reviews, lines, comments] = await Promise.all([
      this.octokit.paginate(this.octokit.rest.pulls.listReviews, { ...target, pull_number: number }),
      this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, { ...target, pull_number: number }),
      this.octokit.paginate(this.octokit.rest.issues.listComments, { ...target, issue_number: number }),
    ])
    const raw: Omit<FeedbackItem, 'canWrite' | 'self'>[] = []
    for (const r of reviews) {
      const reviewState = REVIEW_STATES[r.state]
      // A pending review is not submitted yet and a dismissed one no longer counts.
      if (reviewState && r.submitted_at) raw.push({ kind: 'review', author: r.user?.login ?? '', url: r.html_url, at: r.submitted_at, text: r.body ?? '', reviewState })
    }
    // A line comment drafted with a review is shown to others only when the review is submitted, so that is
    // when it counts as written: otherwise one drafted before a push and submitted after it would look old.
    const submitted = new Map<number, string>()
    for (const r of reviews) if (r.submitted_at) submitted.set(r.id, r.submitted_at)
    for (const c of lines) {
      const line = c.line ?? c.original_line
      const at = (c.pull_request_review_id ? submitted.get(c.pull_request_review_id) : undefined) ?? c.created_at
      raw.push({ kind: 'line', author: c.user?.login ?? '', url: c.html_url, at, text: c.body, path: c.path, ...(line ? { line } : {}) })
    }
    for (const c of comments) raw.push({ kind: 'comment', author: c.user?.login ?? '', url: c.html_url, at: c.created_at, text: c.body ?? '' })
    const authors = new Map<string, Author>()
    for (const r of [...reviews, ...lines, ...comments]) if (r.user) authors.set(r.user.login, r.user)
    const writers = new Map<string, Promise<boolean>>()
    const canWrite = (login: string) => {
      if (!writers.has(login)) writers.set(login, this.canWrite(authors.get(login) ?? null))
      return writers.get(login)!
    }
    const after = Date.parse(since)
    const fresh = raw.filter((i) => Date.parse(i.at) > after)
    return Promise.all(fresh.map(async (i) => ({ ...i, canWrite: await canWrite(i.author), self: isOwn(i, self) })))
  }

  async labelAdded(url: string, label: string): Promise<LabelAdded | null> {
    const number = this.pullNumber(url)
    const events = await this.octokit.paginate(this.octokit.rest.issues.listEvents, { ...this.where(), issue_number: number, per_page: PER_PAGE })
    let latest: (typeof events)[number] | undefined
    for (const e of events) {
      if (e.event !== 'labeled' || !('label' in e) || e.label?.name !== label) continue
      if (latest === undefined || Date.parse(e.created_at) >= Date.parse(latest.created_at)) latest = e
    }
    if (!latest) return null
    // Untrusted like feedback: the actor's permission is looked up, and failing closed means not a writer.
    // Rumba never adds this label, so whoever did is a person, Rumba's own account included.
    const actor = latest.actor ? { login: latest.actor.login, type: latest.actor.type } : null
    return { by: actor?.login ?? '', at: latest.created_at, canWrite: await this.canWrite(actor) }
  }

  /** Fails closed: a bot, an unknown author or any lookup that does not answer is not a writer. */
  private async canWrite(user: Author): Promise<boolean> {
    if (!user || user.type === 'Bot') return false
    try {
      const { data } = await this.octokit.rest.repos.getCollaboratorPermissionLevel({ ...this.where(), username: user.login })
      return WRITE_ROLES.has(data.permission) || WRITE_ROLES.has(data.role_name)
    } catch {
      return false
    }
  }

  async updatePullRequest(url: string, update: { body: string }): Promise<void> {
    await this.octokit.rest.pulls.update({ ...this.where(), pull_number: this.pullNumber(url), body: withMarker(update.body) })
  }

  async commentOnPullRequest(url: string, body: string): Promise<void> {
    // A pull request is an issue to GitHub; its conversation comments are issue comments.
    await this.octokit.rest.issues.createComment({ ...this.where(), issue_number: this.pullNumber(url), body: withMarker(body) })
  }

  async removeLabel(url: string, label: string): Promise<void> {
    const number = this.pullNumber(url)
    try {
      await this.octokit.rest.issues.removeLabel({ ...this.where(), issue_number: number, name: label })
    } catch (e) {
      // The label is already gone.
      if (httpStatus(e) !== 404) throw e
    }
  }

  /** The login Rumba runs as: the one given, else GraphQL viewer, then REST GET /user. Never guessed. */
  private async ownLogin(): Promise<string> {
    if (this.login !== undefined) return this.login
    try {
      const r = await this.octokit.graphql<{ viewer: { login: string } }>('query { viewer { login } }')
      return r.viewer.login
    } catch {
      try {
        return (await this.octokit.rest.users.getAuthenticated()).data.login
      } catch {
        throw new CodeHostIdentityError(UNKNOWN_LOGIN)
      }
    }
  }

  /** The number in a pull request URL of this repository. Anything else is refused, so a stored URL cannot point a request elsewhere. */
  private pullNumber(url: string): number {
    const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url)
    if (!m || m[1]!.toLowerCase() !== this.owner.toLowerCase() || m[2]!.toLowerCase() !== this.repo.toLowerCase()) {
      throw new Error(`Not a pull request of ${this.owner}/${this.repo}: ${url}`)
    }
    return Number(m[3])
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
