import type { RumbaConfig } from '../config/load.js'
import { defaultLabels } from '../core/labels.js'
import { newState, transition } from '../core/states.js'
import type {
  Check, CheckResult, Criterion, LabelNames, LinkedDocument, StateName, Ticket, TicketState,
} from '../core/types.js'
import type { Agent, AgentResult, AgentTask, AgentTaskKind } from '../ports/agent.js'
import type { CodeHost, FeedbackItem, PullRequestDraft, PullRequestInfo } from '../ports/codeHost.js'
import type { Deps } from '../ports/deps.js'
import type { EnvHandle, EnvRef, Environment } from '../ports/environment.js'
import type { Tracker } from '../ports/tracker.js'
import type { Workspace } from '../ports/workspace.js'

type Role = EnvRef['role']

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return { id: '123', ref: '#123', title: 'A ticket', body: 'Something is broken', url: 'https://example.test/issues/123', labels: ['rumba:shop'], ...overrides }
}

export function makeRumba(overrides: Partial<RumbaConfig> = {}): RumbaConfig {
  return {
    name: 'shop',
    dir: '.rumba/shop',
    paths: [],
    tracker: { kind: 'github' },
    agent: { kind: 'claude-code' },
    environment: { kind: 'docker', up: 'docker compose up -d', exec: 'docker compose exec app sh -c', down: 'docker compose down', protected: [], commandTimeoutMinutes: 10, minFreeDiskGb: 5 },
    verify: {},
    checks: { relocate: true },
    sandbox: { nodeVersion: '22' },
    limits: { maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 2 },
    labels: defaultLabels('shop'),
    context: '',
    ...overrides,
  }
}

export class FakeTracker implements Tracker {
  tickets: Ticket[] = []
  closed = new Set<string>()
  states = new Map<string, TicketState>()
  comments: { ticketId: string; body: string }[] = []
  criteriaPosts: { ticketId: string; criteria: Criterion[] }[] = []
  documents: LinkedDocument[] = []
  private onceKeys = new Map<string, Set<string>>()

  constructor(private labels: LabelNames = defaultLabels('shop')) {}

  async ensureLabels(): Promise<void> {}

  async listCandidates(opts: { closedIn?: StateName[] } = {}): Promise<Ticket[]> {
    const closedIn = opts.closedIn ?? []
    return this.tickets.filter((t) => {
      if (!t.labels.includes(this.labels.optIn)) return false
      if (!this.closed.has(t.id)) return true
      const state = this.states.get(t.id)?.state
      return state !== undefined && closedIn.includes(state)
    })
  }

  async getTicket(id: string): Promise<Ticket> {
    const t = this.tickets.find((x) => x.id === id)
    if (!t) throw new Error(`Unknown ticket ${id}`)
    return t
  }

  async readState(t: Ticket): Promise<TicketState | null> {
    const s = this.states.get(t.id)
    return s ? structuredClone(s) : null
  }

  async writeState(t: Ticket, s: TicketState): Promise<void> {
    this.states.set(t.id, structuredClone(s))
    const label = `${this.labels.statePrefix}${s.state}`
    for (const x of this.targets(t)) {
      x.labels = [...x.labels.filter((l) => !l.startsWith(this.labels.statePrefix)), label]
    }
  }

  async postCriteria(t: Ticket, c: Criterion[]): Promise<void> {
    this.criteriaPosts.push({ ticketId: t.id, criteria: structuredClone(c) })
  }

  async readLinkedDocuments(_t: Ticket): Promise<LinkedDocument[]> {
    return this.documents
  }

  async removeLabel(t: Ticket, label: string): Promise<void> {
    for (const x of this.targets(t)) x.labels = x.labels.filter((l) => l !== label)
  }

  async comment(t: Ticket, body: string): Promise<void> {
    this.comments.push({ ticketId: t.id, body })
  }

  async commentOnce(t: Ticket, key: string, body: string): Promise<void> {
    const keys = this.onceKeys.get(t.id) ?? new Set<string>()
    this.onceKeys.set(t.id, keys)
    if (keys.has(key)) return
    keys.add(key)
    await this.comment(t, body)
  }

  private targets(t: Ticket): Ticket[] {
    const stored = this.tickets.find((x) => x.id === t.id)
    return stored && stored !== t ? [t, stored] : [t]
  }
}

export class FakeAgent implements Agent {
  calls: AgentTask[] = []
  /** The workdir of each call, in order. */
  workdirs: string[] = []
  script: Partial<Record<AgentTaskKind, AgentResult | Error | (AgentResult | Error)[]>> = {}
  private played: Partial<Record<AgentTaskKind, number>> = {}

  async run(task: AgentTask, workdir: string): Promise<AgentResult> {
    this.calls.push(task)
    this.workdirs.push(workdir)
    const entry = this.script[task.kind]
    if (entry === undefined) throw new Error(`FakeAgent has no script for task kind ${task.kind}`)
    let item: AgentResult | Error
    if (Array.isArray(entry)) {
      const n = this.played[task.kind] ?? 0
      this.played[task.kind] = n + 1
      item = entry[Math.min(n, entry.length - 1)]!
    } else {
      item = entry
    }
    if (item instanceof Error) throw item
    return item
  }
}

export class FakeEnvironment implements Environment {
  ups: { branch: string; sha: string; role: Role }[] = []
  /** The time left given with each up, in order. */
  upTimeouts: (number | undefined)[] = []
  /** Every command run through runCommand, in order. */
  commandsRun: string[] = []
  commandOutput = ''
  /** When set, up throws it. */
  upError: Error | null = null
  /** The workdir of each up, in order. */
  upWorkdirs: string[] = []
  downs = 0
  canRunCommands = true
  commandExit = 0
  passes: (check: Check, role: Role) => boolean = (_c, role) => role === 'after'
  /** Results the next check runs return, in order, before `passes` decides again. */
  checkResults: Partial<CheckResult>[] = []
  /** Results the next commands return, in order, before `commandExit` decides again. */
  commandResults: { exitCode: number; output: string; infrastructure?: string }[] = []
  /** The criterion of every check run, in order. */
  checksRun: string[] = []
  private roles = new Map<EnvHandle, Role>()

  async up(ref: EnvRef, workdir: string): Promise<EnvHandle> {
    if (this.upError) throw this.upError
    this.ups.push({ branch: ref.branch, sha: ref.sha, role: ref.role })
    this.upTimeouts.push(ref.timeoutMs)
    this.upWorkdirs.push(workdir)
    const h: EnvHandle = { workdir }
    this.roles.set(h, ref.role)
    return h
  }

  async runCheck(h: EnvHandle, check: Check): Promise<CheckResult> {
    this.checksRun.push(check.criterionId)
    const scripted = this.checkResults.shift()
    if (scripted !== undefined) {
      const passed = scripted.passed ?? false
      return { criterionId: check.criterionId, passed, exitCode: scripted.exitCode ?? (passed ? 0 : 1), output: scripted.output ?? '', ...(scripted.infrastructure ? { infrastructure: scripted.infrastructure } : {}) }
    }
    const role = this.roles.get(h) ?? 'after'
    const passed = this.passes(check, role)
    return { criterionId: check.criterionId, passed, exitCode: passed ? 0 : 1, output: passed ? 'check passed' : 'check failed' }
  }

  async runCommand(_h: EnvHandle, command: string): Promise<{ exitCode: number; output: string; infrastructure?: string } | null> {
    if (!this.canRunCommands) return null
    this.commandsRun.push(command)
    return this.commandResults.shift() ?? { exitCode: this.commandExit, output: this.commandOutput }
  }

  async down(_h: EnvHandle): Promise<void> {
    this.downs += 1
  }
}

export class FakeCodeHost implements CodeHost {
  pushed: { branch: string; force: boolean }[] = []
  deleted: string[] = []
  prs: PullRequestDraft[] = []
  /** What getPullRequest returns for a URL. A URL openPullRequest returned and that is not set here is open. */
  pullRequests = new Map<string, Omit<PullRequestInfo, 'labels'> & { labels?: string[] }>()
  /** The feedback listFeedback returns for a URL, filtered by `since`. */
  feedback = new Map<string, FeedbackItem[]>()
  labelsRemoved: { url: string; label: string }[] = []
  pullRequestError: Error | null = null
  private readonly opened = new Set<string>()

  async defaultBranch(): Promise<string> {
    return 'main'
  }

  async pushBranch(_workdir: string, branch: string, opts?: { force?: boolean }): Promise<void> {
    this.pushed.push({ branch, force: opts?.force ?? false })
  }

  async deleteBranch(branch: string): Promise<void> {
    this.deleted.push(branch)
  }

  async openPullRequest(pr: PullRequestDraft): Promise<string> {
    this.prs.push(pr)
    const url = `https://example.test/pr/${this.prs.length}`
    this.opened.add(url)
    return url
  }

  async getPullRequest(url: string): Promise<PullRequestInfo> {
    if (this.pullRequestError) throw this.pullRequestError
    const known = this.pullRequests.get(url)
    if (known) return { ...known, labels: known.labels ?? [] }
    if (this.opened.has(url)) return { state: 'open', headSha: 'head0', labels: [] }
    throw new Error(`FakeCodeHost: no pull request at ${url}`)
  }

  async listFeedback(url: string, since: string): Promise<FeedbackItem[]> {
    return (this.feedback.get(url) ?? []).filter((i) => Date.parse(i.at) > Date.parse(since))
  }

  async removeLabel(url: string, label: string): Promise<void> {
    this.labelsRemoved.push({ url, label })
  }
}

export class FakeWorkspace implements Workspace {
  changed: string[] = []
  /** What hashFiles returns, whatever the directory. Unset: the same hash for every file asked for. */
  hashes: Record<string, string> | undefined = undefined
  commits: string[] = []
  resets: string[] = []
  cleanedAll = 0
  /** Every prepare, commit, reset and cleanup, in order, e.g. `prepare rumba/shop/123 fresh /fake/1`. */
  log: string[] = []
  private prepared = 0

  async prepare(branch: string, opts: { fresh: boolean; like?: string }): Promise<{ workdir: string; baseSha: string }> {
    // Each call gets its own directory, as a real worktree would.
    this.prepared += 1
    const workdir = `/fake/${this.prepared}/${branch}`
    this.branches.set(workdir, branch)
    if (branch !== this.fixBranch && opts.fresh) this.otherTips.set(branch, 'base000')
    this.log.push(`prepare ${branch} ${opts.fresh ? 'fresh' : 'existing'}${opts.like ? ` like ${opts.like}` : ''} ${workdir}`)
    return { workdir, baseSha: 'base000' }
  }

  /** What the next commits return, in order; a null is a commit with nothing to commit. */
  commitResults: (string | null)[] = []
  /** The commit the fix branch points at; commits and resets move it. Starts at the checks commit of `failing`. */
  branchTip = 'sha1'
  /** The fix branch of the default ticket; any other branch keeps its own tip in `otherTips`. */
  fixBranch = 'rumba/shop/123'
  otherTips = new Map<string, string>()
  private branches = new Map<string, string>()

  private tipOf(workdir: string): string {
    const branch = this.branches.get(workdir)
    return branch === undefined || branch === this.fixBranch ? this.branchTip : this.otherTips.get(branch) ?? 'base000'
  }

  private move(workdir: string, sha: string): void {
    const branch = this.branches.get(workdir)
    if (branch === undefined || branch === this.fixBranch) this.branchTip = sha
    else this.otherTips.set(branch, sha)
  }

  async head(workdir: string): Promise<string> {
    return this.tipOf(workdir)
  }

  async commit(workdir: string, message: string, opts?: { allowEmpty?: boolean }): Promise<string | null> {
    this.log.push(`commit ${workdir}${opts?.allowEmpty === true ? ' allowEmpty' : ''}`)
    const scripted = this.commitResults.shift()
    if (scripted === null) return null
    this.commits.push(message)
    this.move(workdir, scripted ?? `sha${this.commits.length}`)
    return this.tipOf(workdir)
  }

  async reset(workdir: string, sha: string): Promise<void> {
    this.move(workdir, sha)
    this.resets.push(sha)
    this.log.push(`reset ${workdir} ${sha}`)
  }

  /** What changedFiles returns since a given commit, when set; otherwise `changed`. */
  changedSince: Record<string, string[]> = {}

  async changedFiles(_workdir: string, sinceSha: string): Promise<string[]> {
    return this.changedSince[sinceSha] ?? this.changed
  }

  async hashFiles(_workdir: string, files: string[]): Promise<Record<string, string>> {
    return this.hashes ?? Object.fromEntries(files.map((f) => [f, 'h0']))
  }

  /** What readFileAt returns: by commit, then by path. */
  files: Record<string, Record<string, string>> = {}

  async readFileAt(_workdir: string, sha: string, file: string): Promise<string | null> {
    return this.files[sha]?.[file] ?? null
  }

  async checkoutFiles(workdir: string, sha: string, files: string[]): Promise<void> {
    this.log.push(`checkout ${workdir} ${sha} ${files.join(' ')}`)
  }

  async cleanup(workdir: string): Promise<void> {
    this.log.push(`cleanup ${workdir}`)
  }

  async cleanupAll(): Promise<void> {
    this.cleanedAll += 1
  }
}

export interface FakeDeps extends Deps {
  tracker: FakeTracker
  agent: FakeAgent
  environment: FakeEnvironment
  codeHost: FakeCodeHost
  workspace: FakeWorkspace
}

export function makeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
  return {
    tracker: new FakeTracker(),
    agent: new FakeAgent(),
    environment: new FakeEnvironment(),
    codeHost: new FakeCodeHost(),
    workspace: new FakeWorkspace(),
    clock: () => new Date('2026-01-01T00:00:00Z'),
    runId: 'run-1',
    secrets: [],
    ...overrides,
  }
}

/** A 'checks_failing' state, built by real transitions, with one failing check c1. */
export function failing(d: FakeDeps): TicketState {
  const now = d.clock()
  let s = newState('shop', now)
  for (const to of ['triaged', 'criteria_ready', 'env_ready', 'checks_failing'] as const) s = transition(s, to, now)
  return {
    ...s,
    kind: 'bug',
    criteria: [{ id: 'c1', text: 'C1', checkable: true }],
    checks: [{ criterionId: 'c1', command: 'npm test -- c1', files: ['tests/rumba/c1.test.ts'] }],
    checkHashes: { 'tests/rumba/c1.test.ts': 'h1' },
    branch: 'rumba/shop/123',
    baseSha: 'base000',
    checksSha: 'sha1',
    before: [{ criterionId: 'c1', passed: false, exitCode: 1, output: 'check failed' }],
  }
}

/** A 'verified' state: the same data as failing(d), built through 'building', plus an after result and a second criterion that cannot be checked. */
export function verified(d: FakeDeps): TicketState {
  const now = d.clock()
  const f = failing(d)
  const s = transition(transition(f, 'building', now), 'verified', now)
  return {
    ...s,
    criteria: [...f.criteria, { id: 'c2', text: 'C2', checkable: false }],
    after: [{ criterionId: 'c1', passed: true, exitCode: 0, output: 'check passed' }],
  }
}

export const happyTriage: Extract<AgentResult, { kind: 'triage' }> = {
  kind: 'triage', workable: true, reason: '', ticketKind: 'bug',
  criteria: [{ id: 'c1', text: 'Saving a profile no longer returns 500', checkable: true }],
}

/** Scripts a bug that triages straight to criteria, fails before the fix and passes after it. */
export function scriptHappyBug(d: FakeDeps): void {
  d.agent.script.triage = happyTriage
  d.agent.script['write-checks'] = {
    kind: 'write-checks',
    checks: [{ criterionId: 'c1', command: 'npm test -- c1', files: ['tests/rumba/c1.test.ts'] }],
  }
  d.agent.script.fix = { kind: 'fix', summary: 'fixed' }
  d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
}

/** Scripts a feature whose ticket has no criteria, so Rumba drafts some and waits. */
export function scriptFeatureWithoutCriteria(d: FakeDeps): void {
  d.agent.script.triage = { ...happyTriage, ticketKind: 'feature', criteria: null }
  d.agent.script['draft-criteria'] = {
    kind: 'draft-criteria',
    criteria: [{ id: 'c1', text: 'Export button exists', checkable: true }],
  }
}
