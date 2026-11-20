import type { Check, CheckResult } from '../../core/types.js'
import { baseBranchOf } from '../../core/labels.js'
import type { CodeHost } from '../../ports/codeHost.js'
import type { EnvHandle, Environment } from '../../ports/environment.js'
import type { Sandbox } from '../../ports/sandbox.js'

type DeploymentState = 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED'
type Deployment = { state: DeploymentState; url: string; target: 'production' | 'preview' | null }

export interface VercelClient {
  findDeployment(o: { sha: string }): Promise<Deployment | null>
}

const API = 'https://api.vercel.com/v7/deployments'
const REQUEST_TIMEOUT_MS = 30 * 1000

/** Every state the API documents, onto the five the environment knows. */
const STATES: Record<string, DeploymentState> = {
  QUEUED: 'QUEUED',
  INITIALIZING: 'QUEUED',
  BUILDING: 'BUILDING',
  READY: 'READY',
  ERROR: 'ERROR',
  BLOCKED: 'ERROR',
  CANCELED: 'CANCELED',
  DELETED: 'CANCELED',
}

type RawDeployment = {
  url?: string | null
  readyState?: string
  state?: string
  target?: string | null
  readySubstate?: string
  created?: number
  createdAt?: number
}

function mapTarget(d: RawDeployment): Deployment['target'] {
  // A deployment that has served production traffic counts as production, whatever its target says.
  if (d.readySubstate === 'PROMOTED' || d.readySubstate === 'ROLLING') return 'production'
  if (d.target === null || d.target === undefined || d.target === 'staging') return null
  if (d.target === 'preview') return 'preview'
  // 'production', and any value the docs do not list, is refused.
  return 'production'
}

/** Looks a deployment up by commit SHA through `GET /v7/deployments`. */
export class HttpVercelClient implements VercelClient {
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly o: { token: string; projectId: string; teamId?: string; fetch?: typeof globalThis.fetch }) {
    this.fetch = o.fetch ?? globalThis.fetch
  }

  async findDeployment({ sha }: { sha: string }): Promise<Deployment | null> {
    const query = new URLSearchParams({ projectId: this.o.projectId, sha })
    if (this.o.teamId !== undefined) query.set('teamId', this.o.teamId)
    const res = await this.fetch(`${API}?${query}`, {
      headers: { Authorization: `Bearer ${this.o.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`Vercel API request to list deployments failed with status ${res.status}.`)
    const body = (await res.json()) as { deployments?: unknown }
    if (!Array.isArray(body.deployments)) throw new Error('Vercel API returned no deployments list.')
    const deployments = body.deployments as RawDeployment[]
    if (deployments.length === 0) return null
    const created = (d: RawDeployment) => d.created ?? d.createdAt ?? 0
    // A production deployment is never used for checks, so one only comes back when there is no other.
    const others = deployments.filter((d) => mapTarget(d) !== 'production')
    const candidates = others.length > 0 ? others : deployments
    const newest = candidates.reduce((a, b) => (created(b) > created(a) ? b : a))
    const raw = newest.readyState ?? newest.state ?? ''
    const state = STATES[raw]
    if (state === undefined) throw new Error(`Vercel deployment has an unknown state: ${raw}`)
    return { state, url: newest.url ?? '', target: mapTarget(newest) }
  }
}

const DEFAULT_POLL_MS = 10 * 1000
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60 * 1000
const BARE_HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/
/** Failed lookups in a row that `up` waits through; the next one ends the wait. */
const MAX_FAILED_LOOKUPS = 3

export class VercelPreviewEnvironment implements Environment {
  private readonly pollMs: number
  private readonly timeoutMs: number
  private readonly checkTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  /** The throwaway base branch each handle's `up` pushed. */
  private readonly baseBranches = new Map<EnvHandle, string>()

  constructor(private readonly o: {
    client: VercelClient
    codeHost: CodeHost
    sandbox: Sandbox
    bypassSecret?: string
    pollMs?: number
    timeoutMs?: number
    checkTimeoutMs?: number
    sleep?: (ms: number) => Promise<void>
  }) {
    this.pollMs = o.pollMs ?? DEFAULT_POLL_MS
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.checkTimeoutMs = o.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    this.sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async up(ref: { branch: string; sha: string; role: 'before' | 'after' }, workdir: string): Promise<EnvHandle> {
    // The branch may be left over from an earlier attempt, so both pushes force.
    const pushed = ref.role === 'before' ? baseBranchOf(ref.branch) : null
    await this.o.codeHost.pushBranch(workdir, pushed ?? ref.branch, { force: true })
    try {
      const host = await this.waitForReady(ref.sha)
      const h: EnvHandle = { workdir, baseUrl: `https://${host}` }
      if (pushed !== null) this.baseBranches.set(h, pushed)
      return h
    } catch (err) {
      // The caller only calls down after a successful up, so the throwaway branch goes now.
      if (pushed !== null) await this.deleteQuietly(pushed)
      throw err
    }
  }

  async runCheck(h: EnvHandle, check: Check): Promise<CheckResult> {
    const env: Record<string, string> = { RUMBA_BASE_URL: h.baseUrl ?? '' }
    if (this.o.bypassSecret !== undefined) env.VERCEL_AUTOMATION_BYPASS_SECRET = this.o.bypassSecret
    const r = await this.o.sandbox.run({ workdir: h.workdir, command: ['sh', '-c', check.command], env, timeoutMs: this.checkTimeoutMs })
    return { criterionId: check.criterionId, passed: r.exitCode === 0, exitCode: r.exitCode, output: r.output }
  }

  async runCommand(_h: EnvHandle, _command: string): Promise<null> {
    return null
  }

  async down(h: EnvHandle): Promise<void> {
    const branch = this.baseBranches.get(h)
    if (branch === undefined) return
    this.baseBranches.delete(h)
    await this.deleteQuietly(branch)
  }

  /**
   * Polls until the deployment for `sha` is READY and returns its host name. A production
   * deployment is never used: it counts as not there yet, since a preview may still follow.
   */
  private async waitForReady(sha: string): Promise<string> {
    let elapsed = 0
    let failedLookups = 0
    let sawProduction = false
    let sawOther = false
    for (;;) {
      let d: Deployment | null = null
      try {
        d = await this.o.client.findDeployment({ sha })
        failedLookups = 0
      } catch (err) {
        failedLookups += 1
        if (failedLookups > MAX_FAILED_LOOKUPS) throw err
      }
      if (d !== null && d.target === 'production') {
        sawProduction = true
      } else if (d !== null) {
        sawOther = true
        if (d.state === 'ERROR' || d.state === 'CANCELED') throw new Error(`Vercel deployment for ${sha} ended in state ${d.state}.`)
        if (d.state === 'READY') {
          if (!BARE_HOST.test(d.url)) throw new Error(`Vercel deployment for ${sha} has a URL that is not a bare host name.`)
          return d.url
        }
      }
      if (elapsed + this.pollMs > this.timeoutMs) {
        const onlyProduction = sawProduction && !sawOther
          ? ' Only a production deployment was found. Refusing to run checks against a production deployment.'
          : ''
        throw new Error(`Vercel deployment for ${sha} did not become ready within ${this.timeoutMs} ms.${onlyProduction}`)
      }
      await this.sleep(this.pollMs)
      elapsed += this.pollMs
    }
  }

  private async deleteQuietly(branch: string): Promise<void> {
    try {
      await this.o.codeHost.deleteBranch(branch)
    } catch {
      // A failed cleanup must not hide the result of the run.
    }
  }
}
