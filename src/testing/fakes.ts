import type { RumbaConfig } from '../config/load.js'
import { defaultLabels } from '../core/labels.js'
import { newState, transition } from '../core/states.js'
import type {
  Check, CheckResult, Criterion, LabelNames, LinkedDocument, Ticket, TicketState,
} from '../core/types.js'
import type { Agent, AgentResult, AgentTask, AgentTaskKind } from '../ports/agent.js'
import type { CodeHost, PullRequestDraft } from '../ports/codeHost.js'
import type { Deps } from '../ports/deps.js'
import type { EnvHandle, Environment } from '../ports/environment.js'
import type { Tracker } from '../ports/tracker.js'
import type { Workspace } from '../ports/workspace.js'

type Role = 'before' | 'after'

export function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return { id: '123', ref: '#123', title: 'A ticket', body: 'Something is broken', url: 'https://example.test/issues/123', labels: ['rumba:hub'], ...overrides }
}

export function makeRumba(overrides: Partial<RumbaConfig> = {}): RumbaConfig {
  return {
    name: 'hub',
    dir: '.rumba/hub',
    paths: [],
    tracker: { kind: 'github' },
    agent: { kind: 'claude-code' },
    environment: { kind: 'docker', up: 'docker compose up -d', exec: 'docker compose exec app sh -c', down: 'docker compose down', protected: [] },
    verify: {},
    limits: { maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 2 },
    labels: defaultLabels('hub'),
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

  constructor(private labels: LabelNames = defaultLabels('hub')) {}

  async ensureLabels(): Promise<void> {}

  async listCandidates(): Promise<Ticket[]> {
    return this.tickets.filter((t) => t.labels.includes(this.labels.optIn) && !this.closed.has(t.id))
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
  /** The workdir of each up, in order. */
  upWorkdirs: string[] = []
  downs = 0
  canRunCommands = true
  commandExit = 0
  passes: (check: Check, role: Role) => boolean = (_c, role) => role === 'after'
  private roles = new Map<EnvHandle, Role>()

  async up(ref: { branch: string; sha: string; role: Role }, workdir: string): Promise<EnvHandle> {
    this.ups.push({ ...ref })
    this.upWorkdirs.push(workdir)
    const h: EnvHandle = { workdir }
    this.roles.set(h, ref.role)
    return h
  }

  async runCheck(h: EnvHandle, check: Check): Promise<CheckResult> {
    const role = this.roles.get(h) ?? 'after'
    const passed = this.passes(check, role)
    return { criterionId: check.criterionId, passed, exitCode: passed ? 0 : 1, output: passed ? 'check passed' : 'check failed' }
  }

  async runCommand(_h: EnvHandle, _command: string): Promise<{ exitCode: number; output: string } | null> {
    return this.canRunCommands ? { exitCode: this.commandExit, output: '' } : null
  }

  async down(_h: EnvHandle): Promise<void> {
    this.downs += 1
  }
}

export class FakeCodeHost implements CodeHost {
  pushed: { branch: string; force: boolean }[] = []
  deleted: string[] = []
  prs: PullRequestDraft[] = []

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
    return `https://example.test/pr/${this.prs.length}`
  }
}

export class FakeWorkspace implements Workspace {
  changed: string[] = []
  /** What hashFiles returns, whatever the directory. Unset: the same hash for every file asked for. */
  hashes: Record<string, string> | undefined = undefined
  commits: string[] = []
  resets: string[] = []
  cleanedAll = 0
  /** Every prepare, commit, reset and cleanup, in order, e.g. `prepare rumba/hub/123 fresh /fake/1`. */
  log: string[] = []
  private prepared = 0

  async prepare(branch: string, opts: { fresh: boolean }): Promise<{ workdir: string; baseSha: string }> {
    // Each call gets its own directory, as a real worktree would.
    this.prepared += 1
    const workdir = `/fake/${this.prepared}/${branch}`
    this.log.push(`prepare ${branch} ${opts.fresh ? 'fresh' : 'existing'} ${workdir}`)
    return { workdir, baseSha: 'base000' }
  }

  async commit(workdir: string, message: string, opts?: { allowEmpty?: boolean }): Promise<string | null> {
    this.commits.push(message)
    this.log.push(`commit ${workdir}${opts?.allowEmpty === true ? ' allowEmpty' : ''}`)
    return `sha${this.commits.length}`
  }

  async reset(workdir: string, sha: string): Promise<void> {
    this.resets.push(sha)
    this.log.push(`reset ${workdir} ${sha}`)
  }

  async changedFiles(_workdir: string, _sinceSha: string): Promise<string[]> {
    return this.changed
  }

  async hashFiles(_workdir: string, files: string[]): Promise<Record<string, string>> {
    return this.hashes ?? Object.fromEntries(files.map((f) => [f, 'h0']))
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
  let s = newState('hub', now)
  for (const to of ['triaged', 'criteria_ready', 'env_ready', 'checks_failing'] as const) s = transition(s, to, now)
  return {
    ...s,
    kind: 'bug',
    criteria: [{ id: 'c1', text: 'C1', checkable: true }],
    checks: [{ criterionId: 'c1', command: 'npm test -- c1', files: ['tests/rumba/c1.test.ts'] }],
    checkHashes: { 'tests/rumba/c1.test.ts': 'h1' },
    branch: 'rumba/hub/123',
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
