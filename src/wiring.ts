import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Octokit } from '@octokit/rest'
import { ClaudeCodeAgent } from './adapters/agent/claudeCode.js'
import { GeminiCliAgent } from './adapters/agent/geminiCli.js'
import { GitHubCodeHost } from './adapters/codeHost/github.js'
import path from 'node:path'
import { DockerEnvironment } from './adapters/environment/docker.js'
import { dockerDisk, dockerProbe } from './adapters/environment/dockerProbe.js'
import { HostLock } from './adapters/environment/hostLock.js'
import { FileRunRecords, recordingAgent, recordsDirFor, rumbaHome } from './adapters/records.js'
import { HttpVercelClient, VercelPreviewEnvironment } from './adapters/environment/vercelPreview.js'
import { DockerSandbox } from './adapters/sandbox/docker.js'
import { GitHubTracker } from './adapters/tracker/github.js'
import { LinearTracker, SdkLinearGateway } from './adapters/tracker/linear.js'
import { GitWorkspace, RUMBA_IDENTITY } from './adapters/workspace/git.js'
import type { RumbaConfig } from './config/load.js'
import { redact, redactDeep } from './core/redact.js'
import { STATE_NAMES } from './core/states.js'
import type { Agent } from './ports/agent.js'
import type { CodeHost } from './ports/codeHost.js'
import type { Deps } from './ports/deps.js'
import type { Environment } from './ports/environment.js'
import type { Sandbox } from './ports/sandbox.js'
import type { Tracker } from './ports/tracker.js'

export class MissingKeyError extends Error {}

/** The package's sandbox folder, holding the image's Dockerfile; the same relative path from `src/` and from `dist/`. */
export const SANDBOX_DIR = fileURLToPath(new URL('../sandbox', import.meta.url))

type Env = Record<string, string | undefined>

/** Variables whose values must never be printed or posted. Ids and the login are not secret. */
const SECRET_VARIABLES = [
  'RUMBA_GITHUB_TOKEN', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY',
  'VERCEL_TOKEN', 'VERCEL_AUTOMATION_BYPASS_SECRET',
]

/** The value of a variable that is set and not empty. */
function value(env: Env, name: string): string | undefined {
  const v = env[name]
  return v === undefined || v === '' ? undefined : v
}

function required(env: Env, name: string, why: string): string {
  const v = value(env, name)
  if (v === undefined) throw new MissingKeyError(`${name} is not set. ${why}`)
  return v
}

/** The values of every secret variable that is set, for redaction. */
export function secretValues(env: Env): string[] {
  return SECRET_VARIABLES.map((name) => value(env, name)).filter((v): v is string => v !== undefined)
}

const GITHUB_PATTERNS = [
  /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  /^ssh:\/\/git@github\.com(?::22)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
]
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/

/** Owner and repository name from a github.com remote URL, over https or ssh. */
export function parseRemote(url: string): { owner: string; name: string } {
  for (const pattern of GITHUB_PATTERNS) {
    const m = pattern.exec(url.trim())
    if (m && GITHUB_SEGMENT.test(m[1]) && GITHUB_SEGMENT.test(m[2])) return { owner: m[1], name: m[2] }
  }
  throw new Error('Rumba stage 1 supports GitHub remotes only: the origin remote must be a github.com repository, over https or ssh.')
}

function githubToken(rumba: RumbaConfig, env: Env): string {
  const token = value(env, 'RUMBA_GITHUB_TOKEN') ?? value(env, 'GITHUB_TOKEN')
  if (token === undefined) {
    const uses = rumba.tracker.kind === 'github' ? 'GitHub as its tracker and code host' : 'GitHub as its code host'
    throw new MissingKeyError(`RUMBA_GITHUB_TOKEN is not set, and neither is GITHUB_TOKEN. Rumba "${rumba.name}" uses ${uses}.`)
  }
  return token
}

function trackerFor(rumba: RumbaConfig, env: Env, repo: { owner: string; name: string }, octokit: () => Octokit): Tracker {
  const common = { labels: rumba.labels, stateNames: [...STATE_NAMES] }
  if (rumba.tracker.kind === 'linear') {
    const apiKey = required(env, 'LINEAR_API_KEY', `Rumba "${rumba.name}" uses the linear tracker.`)
    // The config loader refuses a linear tracker without a team.
    const team = rumba.tracker.team ?? ''
    return new LinearTracker({ gateway: new SdkLinearGateway(apiKey), team, project: rumba.tracker.project, ...common })
  }
  const login = value(env, 'RUMBA_GITHUB_LOGIN')
  return new GitHubTracker({ octokit: octokit(), owner: repo.owner, repo: repo.name, ...common, ...(login === undefined ? {} : { login }) })
}

/** Only the tracker of a rumba, for commands that read tickets and change nothing else. */
export function buildTracker(rumba: RumbaConfig, env: Env, repo: { owner: string; name: string }): Tracker {
  return trackerFor(rumba, env, repo, () => new Octokit({ auth: githubToken(rumba, env) }))
}

function agentFor(rumba: RumbaConfig, env: Env, sandbox: Sandbox): Agent {
  const why = `Rumba "${rumba.name}" uses the ${rumba.agent.kind} agent.`
  const timeoutMs = rumba.limits.minutesPerTicket * 60_000
  const { model } = rumba.agent
  if (rumba.agent.kind === 'gemini-cli') return new GeminiCliAgent({ sandbox, apiKey: required(env, 'GEMINI_API_KEY', why), model, timeoutMs })
  // An API key, or a token from `claude setup-token` for a Claude subscription. Claude Code
  // prefers the key when both are set, so only that one is passed.
  const apiKey = value(env, 'ANTHROPIC_API_KEY')
  const oauthToken = value(env, 'CLAUDE_CODE_OAUTH_TOKEN')
  if (apiKey !== undefined) return new ClaudeCodeAgent({ sandbox, apiKey, model, timeoutMs })
  if (oauthToken !== undefined) return new ClaudeCodeAgent({ sandbox, oauthToken, model, timeoutMs })
  throw new MissingKeyError(`ANTHROPIC_API_KEY is not set, and neither is CLAUDE_CODE_OAUTH_TOKEN. ${why}`)
}

function environmentFor(rumba: RumbaConfig, env: Env, codeHost: CodeHost, sandbox: Sandbox, workspace: GitWorkspace): Environment {
  const e = rumba.environment
  // Host-side commands run in checkouts of the default branch that the workspace hands out.
  if (e.kind === 'docker') {
    return new DockerEnvironment({
      up: e.up, exec: e.exec, down: e.down, trusted: workspace, timeoutMs: e.commandTimeoutMinutes * 60_000,
      // One docker environment at a time on this machine, across Rumba processes.
      lock: new HostLock({ file: path.join(rumbaHome(env), 'environment.lock') }),
      docker: dockerProbe,
      ...(e.minFreeDiskGb > 0 ? { disk: dockerDisk, minFreeBytes: e.minFreeDiskGb * 2 ** 30 } : {}),
    })
  }
  const why = `Rumba "${rumba.name}" uses the vercel-preview environment`
  const token = required(env, 'VERCEL_TOKEN', `${why}.`)
  const projectId = e.projectId ?? required(env, 'VERCEL_PROJECT_ID', `${why} and its rumba.yml sets no environment.project_id.`)
  const teamId = value(env, 'VERCEL_TEAM_ID')
  const bypassSecret = value(env, 'VERCEL_AUTOMATION_BYPASS_SECRET')
  return new VercelPreviewEnvironment({
    client: new HttpVercelClient({ token, projectId, ...(teamId === undefined ? {} : { teamId }) }),
    codeHost,
    sandbox,
    ...(bypassSecret === undefined ? {} : { bypassSecret }),
  })
}

/**
 * The tracker, with every text it posts or stores passed through `redact` first. The ticket
 * objects are passed through unchanged, so label updates the tracker makes on them still land.
 */
export function redactingTracker(inner: Tracker, secrets: string[]): Tracker {
  const r = (text: string) => redact(text, secrets)
  return {
    ensureLabels: () => inner.ensureLabels(),
    listCandidates: () => inner.listCandidates(),
    getTicket: (id) => inner.getTicket(id),
    readState: (t) => inner.readState(t),
    writeState: (t, s) => inner.writeState(t, redactDeep(s, secrets)),
    postCriteria: (t, c) => inner.postCriteria(t, c.map((x) => ({ ...x, text: r(x.text) }))),
    readLinkedDocuments: (t) => inner.readLinkedDocuments(t),
    removeLabel: (t, label) => inner.removeLabel(t, label),
    comment: (t, body) => inner.comment(t, r(body)),
    commentOnce: (t, key, body) => inner.commentOnce(t, key, r(body)),
  }
}

/** The code host, with the pull request's title and body passed through `redact` first. */
export function redactingCodeHost(inner: CodeHost, secrets: string[]): CodeHost {
  return {
    defaultBranch: () => inner.defaultBranch(),
    pushBranch: (workdir, branch, opts) => inner.pushBranch(workdir, branch, opts),
    deleteBranch: (branch) => inner.deleteBranch(branch),
    openPullRequest: (pr) => inner.openPullRequest({ ...pr, title: redact(pr.title, secrets), body: redact(pr.body, secrets) }),
  }
}

/** Builds the real adapters for one rumba. Constructs objects only: no I/O and no network call. */
export function buildDeps(
  rumba: RumbaConfig,
  env: Record<string, string | undefined>,
  repo: { root: string; owner: string; name: string; defaultBranch: string },
): Deps {
  const token = githubToken(rumba, env)
  // A commit author set half way is a mistake to report now, not to fall back from later.
  if ((value(env, 'RUMBA_COMMIT_AUTHOR_NAME') === undefined) !== (value(env, 'RUMBA_COMMIT_AUTHOR_EMAIL') === undefined)) {
    throw new MissingKeyError('RUMBA_COMMIT_AUTHOR_NAME and RUMBA_COMMIT_AUTHOR_EMAIL must be set together.')
  }
  const octokit = new Octokit({ auth: token })
  const tracker = trackerFor(rumba, env, repo, () => octokit)
  // Always Rumba's own Dockerfile; the rumba chooses only the Node major version.
  const sandbox = new DockerSandbox({ dockerfileDir: SANDBOX_DIR, nodeVersion: rumba.sandbox.nodeVersion })
  const secrets = secretValues(env)
  const runId = randomUUID()
  // Every agent call leaves a record under the run's folder, which `rumba run` prints at the end.
  const agent = recordingAgent(agentFor(rumba, env, sandbox), new FileRunRecords(recordsDirFor(runId, env)), secrets)
  const codeHost = new GitHubCodeHost({ octokit, owner: repo.owner, repo: repo.name, token, repoRoot: repo.root })
  const workspace = new GitWorkspace({
    repoRoot: repo.root, defaultBranch: repo.defaultBranch,
    author: () => resolveCommitAuthor(env, rumba.commitAuthor, () => githubAccount(octokit)),
  })
  const environment = environmentFor(rumba, env, codeHost, sandbox, workspace)
  return {
    tracker: redactingTracker(tracker, secrets),
    agent,
    environment,
    codeHost: redactingCodeHost(codeHost, secrets),
    workspace,
    clock: () => new Date(),
    runId,
    secrets,
  }
}

/** The GitHub account a token belongs to: GraphQL viewer, then REST GET /user. Null when neither answers. */
export async function githubAccount(octokit: Octokit): Promise<{ login: string; id: number } | null> {
  try {
    const r = await octokit.graphql<{ viewer: { login: string; databaseId: number } }>('query { viewer { login databaseId } }')
    if (r.viewer.login && Number.isInteger(r.viewer.databaseId)) return { login: r.viewer.login, id: r.viewer.databaseId }
  } catch {
    // Some tokens cannot ask for the viewer; try the REST endpoint.
  }
  try {
    const { data } = await octokit.rest.users.getAuthenticated()
    return { login: data.login, id: data.id }
  } catch {
    return null
  }
}

/**
 * Who Rumba's commits are made as, in this order: RUMBA_COMMIT_AUTHOR_NAME and
 * RUMBA_COMMIT_AUTHOR_EMAIL; `commit_author` in rumba.yml; the GitHub account Rumba runs as,
 * with its noreply address, so integrations that check the author (a deployment that needs
 * the author to be a member, say) recognise it; and last, Rumba's own identity.
 */
export async function resolveCommitAuthor(
  env: Env, fromConfig: { name: string; email: string } | undefined, lookup: () => Promise<{ login: string; id: number } | null>,
): Promise<{ name: string; email: string }> {
  const name = value(env, 'RUMBA_COMMIT_AUTHOR_NAME')
  const email = value(env, 'RUMBA_COMMIT_AUTHOR_EMAIL')
  if (name !== undefined || email !== undefined) {
    if (name === undefined || email === undefined) {
      throw new MissingKeyError('RUMBA_COMMIT_AUTHOR_NAME and RUMBA_COMMIT_AUTHOR_EMAIL must be set together.')
    }
    return { name, email }
  }
  if (fromConfig !== undefined) return fromConfig
  const account = await lookup().catch(() => null)
  if (account !== null) return { name: account.login, email: `${account.id}+${account.login}@users.noreply.github.com` }
  return RUMBA_IDENTITY
}
