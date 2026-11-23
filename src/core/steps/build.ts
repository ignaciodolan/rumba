import type { RumbaConfig } from '../../config/load.js'
import type { AgentTask } from '../../ports/agent.js'
import type { Deps } from '../../ports/deps.js'
import { type EnvHandle, InfrastructureError } from '../../ports/environment.js'
import { timeLeft } from '../budget.js'
import { changedChecks, protectedViolations } from '../guards.js'
import { checkOutputMax, cleanOutput } from '../redact.js'
import { transition } from '../states.js'
import type { AttemptRecord, CheckResult, ProjectTestsResult, Ticket, TicketState } from '../types.js'
import { cleanupQuietly, downQuietly } from './teardown.js'

export type Failure = { criterionId: string; output: string }

/** Exit codes of a command that timed out (124), could not execute (126) or was not found (127). */
export const COULD_NOT_RUN = [124, 126, 127]

/** The tail of the output kept with each attempt on the ticket. */
export const ATTEMPT_TAIL = 1000
/** At most this many attempts are kept on the ticket, the latest. */
const MAX_ATTEMPTS_KEPT = 10
const MAX_SUMMARY = 2000

/** For a docker environment, the prefix that runs a check in the project's container, so the agent can be told. */
export function execPrefixOf(rumba: RumbaConfig): { execPrefix?: string } {
  return rumba.environment.kind === 'docker' ? { execPrefix: rumba.environment.exec } : {}
}

function fromResults(results: CheckResult[], secrets: string[]): Failure[] {
  return results.filter((r) => !r.passed).map((r) => ({ criterionId: r.criterionId, output: cleanOutput(r.output, secrets) }))
}

/**
 * What a verification compares and where it puts the branch back: the check files and their
 * hashes, and the commit a changed check file is reset to.
 */
export interface Lock { files: string[]; hashes: Record<string, string>; resetTo: string }

/** What one verification of a commit found. */
export type Verdict =
  | { kind: 'passed'; results: CheckResult[]; projectTests: ProjectTestsResult }
  | { kind: 'checks-failed' | 'project-tests-failed'; results: CheckResult[]; projectTests: ProjectTestsResult; failures: Failure[]; tail: string }
  | { kind: 'guard'; failures: Failure[] }
  | { kind: 'infrastructure'; results: CheckResult[]; projectTests: ProjectTestsResult; reason: string; tail: string }

export async function build(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'checks_failing') throw new Error(`Cannot build from state ${state.state}`)
  const { branch, checksSha } = state
  if (!branch || !checksSha) throw new Error('Cannot build without a branch and a checks commit')

  let current = transition(state, 'building', deps.clock())
  await deps.tracker.writeState(ticket, current)

  // Where things stand on the base run: every check fails there.
  const atBase = {
    failures: fromResults(state.before ?? [], deps.secrets),
    situation: { checkStatus: (state.before ?? []).map((r) => ({ criterionId: r.criterionId, passed: r.passed })), projectTests: 'not-run' } as Pick<AgentTask, 'checkStatus' | 'projectTests'>,
  }
  let failures: Failure[] = atBase.failures
  let situation = atBase.situation
  // On a later run (after an infrastructure error, say), start from the last attempt on the ticket.
  const lastRecorded = state.attempts?.at(-1)
  if (lastRecorded && lastRecorded.checks.length > 0) {
    situation = { checkStatus: lastRecorded.checks.map(({ criterionId, passed }) => ({ criterionId, passed })), projectTests: lastRecorded.projectTests }
    if (lastRecorded.tail !== '') failures = [{ criterionId: lastRecorded.outcome === 'project-tests-failed' || lastRecorded.projectTests !== 'not-run' ? 'project-tests' : lastRecorded.outcome, output: lastRecorded.tail }]
  }
  const checkFiles = [...new Set([...Object.keys(state.checkHashes), ...state.checks.flatMap((c) => c.files)])]
  // The commit at the head of the fix branch, which a re-verification runs against. It is read
  // from the branch in every attempt, so a fix committed in an earlier run counts.
  let head = checksSha
  const lock: Lock = { files: checkFiles, hashes: state.checkHashes, resetTo: checksSha }

  const nextNumber = () => (current.attempts?.at(-1)?.n ?? 0) + 1
  const record = async (r: Omit<AttemptRecord, 'n'>, extra: Partial<TicketState> = {}): Promise<void> => {
    const attempts = [...(current.attempts ?? []), { n: nextNumber(), ...r }].slice(-MAX_ATTEMPTS_KEPT)
    current = { ...current, ...extra, attempts }
    await deps.tracker.writeState(ticket, current)
  }

  while (current.fixAttempts < rumba.limits.maxFixAttempts) {
    const fixed = await fixOnce(deps, rumba, ticket, current, failures, checkFiles, situation, nextNumber())
    head = fixed.tip

    if ('noChange' in fixed && head === checksSha) {
      // Nothing was ever committed on top of the checks: passing now would open a pull request
      // with no fix in it, so this always goes to a person.
      const note = `The agent said no change was needed: ${fixed.noChange}`
      await record({ outcome: 'no-change', checks: [], projectTests: 'not-run', note, tail: '' })
      await deps.tracker.comment(ticket, [
        `The agent says no change is needed: ${cleanOutput(fixed.noChange, deps.secrets, MAX_SUMMARY)}`,
        'There is no fix commit on the branch, only the checks, so Rumba will not open a pull request. A person needs to decide.',
      ].join('\n'))
      current = transition(current, 'needs_human', deps.clock(), 'agent says no change is needed')
      await deps.tracker.writeState(ticket, current)
      return current
    }

    if ('noChange' in fixed) {
      // The agent found nothing to change. Verify once more as the code stands; a pass now
      // counts, and a failure goes to a person with the agent's reason.
      const note = `The agent said no change was needed: ${fixed.noChange}`
      // One strict run: a re-verification is never given a second try.
      const v = await verifyOnce(deps, rumba, current, head, lock)
      if (v.kind === 'infrastructure') return await stopForInfrastructure(v, note)
      if (v.kind === 'passed') {
        await record({ outcome: 'verified', checks: brief(v.results), projectTests: v.projectTests, note, tail: '' }, { fixSummary: summaryOf(fixed.summary, deps) })
        current = { ...transition(current, 'verified', deps.clock()), after: v.results }
        await deps.tracker.writeState(ticket, current)
        return current
      }
      const tail = 'tail' in v ? v.tail : v.failures.map((f) => f.output).join('\n')
      await record({ outcome: 'no-change', checks: 'results' in v ? brief(v.results) : [], projectTests: 'projectTests' in v ? v.projectTests : 'not-run', note, tail })
      await deps.tracker.comment(ticket, [
        `The agent says no change is needed: ${cleanOutput(fixed.noChange, deps.secrets, MAX_SUMMARY)}`,
        `Rumba verified the code again as it stands, and it still does not pass: ${describe(current.attempts!.at(-1)!)}.`,
        'A person needs to decide.', '', fence(tail),
      ].join('\n'))
      current = transition(current, 'needs_human', deps.clock(), 'agent says no change is needed')
      await deps.tracker.writeState(ticket, current)
      return current
    }

    let v: Verdict
    if ('sha' in fixed) {
      v = await verify(deps, rumba, current, fixed.sha, lock)
      if (v.kind === 'guard') head = checksSha
    } else {
      v = { kind: 'guard', failures: fixed.failures }
    }

    if (v.kind === 'infrastructure') return await stopForInfrastructure(v)
    if (v.kind === 'passed') {
      await record({ outcome: 'verified', checks: brief(v.results), projectTests: v.projectTests, tail: '' }, { fixSummary: summaryOf(fixed.summary, deps) })
      current = { ...transition(current, 'verified', deps.clock()), after: v.results }
      await deps.tracker.writeState(ticket, current)
      return current
    }
    if (v.kind === 'guard') {
      await record({ outcome: 'guard', checks: [], projectTests: 'not-run', note: cleanOutput(v.failures[0]?.output ?? '', deps.secrets, ATTEMPT_TAIL), tail: '' })
      // A rejected fix that was reset leaves the branch as it was after the checks commit.
      if (head === checksSha) situation = atBase.situation
    } else {
      await record({ outcome: v.kind, checks: brief(v.results), projectTests: v.projectTests, tail: v.tail })
      situation = { checkStatus: brief(v.results).map(({ criterionId, passed }) => ({ criterionId, passed })), projectTests: v.projectTests }
    }
    failures = v.failures
    current = { ...current, fixAttempts: current.fixAttempts + 1 }
    await deps.tracker.writeState(ticket, current)
  }

  const attempts = current.fixAttempts
  const last = current.attempts?.at(-1)
  const what = last?.outcome === 'project-tests-failed' ? "the project's own tests" : 'the checks'
  const details = failures.map((f) => `${f.criterionId}:\n${f.output}`).join('\n\n')
  const headline = last?.outcome === 'guard'
    ? `Rumba could not fix this after ${attempts} attempts: the last fix was rejected.`
    : `Rumba could not fix this: ${what} still fail after ${attempts} attempts.`
  const comment = [
    headline, '',
    ...(current.attempts ?? []).map((a) => `- Attempt ${a.n}: ${describe(a)}`), '',
    'Last failures:', '', details,
  ].join('\n')
  await deps.tracker.comment(ticket, comment)
  current = transition(current, 'fix_failed', deps.clock(), `${what} still fail after ${attempts} attempts`)
  await deps.tracker.writeState(ticket, current)
  return current

  /** Records the attempt, then counts an error on the ticket: the machine failed, not the change. */
  async function stopForInfrastructure(v: Extract<Verdict, { kind: 'infrastructure' }>, note?: string): Promise<never> {
    await record({ outcome: 'infrastructure', checks: brief(v.results), projectTests: v.projectTests, ...(note ? { note } : {}), tail: v.tail })
    throw new InfrastructureError(v.reason)
  }
}

/**
 * A ticket title made safe to put in a commit message or a pull request title: an issue
 * reference such as "fixes #42" in it can no longer close that issue when the change merges.
 */
export function inertTitle(title: string): string {
  return title.replace(/#(?=\d)/g, '#\u200b').replace(/\/(issues|pull)\//gi, '/$1\u200b/')
}

export function brief(results: CheckResult[]): AttemptRecord['checks'] {
  return results.map((r) => ({ criterionId: r.criterionId, passed: r.passed, exitCode: r.exitCode }))
}

function summaryOf(summary: string, deps: Deps): string {
  return cleanOutput(summary, deps.secrets, MAX_SUMMARY)
}

/** One line on an attempt, for the ticket. */
export function describe(a: AttemptRecord): string {
  const checks = a.checks.map((c) => `${c.criterionId} ${c.passed ? 'passed' : 'failed'}`).join(', ')
  switch (a.outcome) {
    case 'verified': return `verified${a.note ? ` (${a.note})` : ''}`
    case 'checks-failed': return `checks failed (${checks})`
    case 'project-tests-failed': return "every check passed; the project's own tests failed"
    case 'guard': return `rejected: ${a.note ?? 'the change broke a rule'}`
    case 'no-change': return a.checks.every((c) => c.passed) && a.projectTests === 'failed'
      ? "every check passed; the project's own tests failed"
      : a.checks.length > 0 ? `checks failed (${checks})` : 'not verified'
    case 'infrastructure': return `stopped by the machine, not the change${a.note ? ` (${a.note})` : ''}`
  }
}

export function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}\n${text}\n${f}`
}

/**
 * One fix in a new worktree of the branch: the agent changes the code, Rumba commits and
 * guards the commit, and the worktree is removed. A rejected commit is reset off the branch.
 */
async function fixOnce(
  deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, failures: Failure[], checkFiles: string[],
  situation: Pick<AgentTask, 'checkStatus' | 'projectTests'>, attempt: number,
): Promise<({ sha: string } | { failures: Failure[] } | { noChange: string }) & { summary: string; tip: string }> {
  const { workdir } = await deps.workspace.prepare(state.branch!, { fresh: false })
  try {
    const result = await deps.agent.run({
      kind: 'fix', ticket, context: rumba.context, environmentKind: rumba.environment.kind, timeoutMs: timeLeft(deps), ...execPrefixOf(rumba),
      criteria: state.criteria, checks: state.checks, failures, lockedFiles: checkFiles, attempt, ...situation,
    }, workdir)
    if (result.kind !== 'fix') throw new Error(`Agent returned ${result.kind} for a fix task`)

    const sha = await deps.workspace.commit(workdir, `fix: ${inertTitle(ticket.title)} (${ticket.ref})`)
    if (sha === null) {
      const tip = await deps.workspace.head(workdir)
      if (result.noChangeNeeded !== undefined) return { noChange: result.noChangeNeeded, summary: result.summary, tip }
      return { failures: [{ criterionId: 'guard', output: 'The agent changed no files.' }], summary: result.summary, tip }
    }
    const guard = await protectedFailure(deps, rumba, workdir, state.checksSha!)
    if (guard) {
      await deps.workspace.reset(workdir, state.checksSha!)
      return { failures: [{ criterionId: 'guard', output: guard }], summary: result.summary, tip: state.checksSha! }
    }
    return { sha, summary: result.summary, tip: sha }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/**
 * Verifies a fix, and when it does not pass, verifies it once more before the failure counts:
 * a test may be flaky, or the machine may have run out of memory. The second run is a fresh
 * checkout and a fresh environment, never the same containers again, so the code under test
 * cannot pass the second time by leaving something behind the first time, or by faking a
 * crash. The second verdict is the one that counts.
 */
export async function verify(deps: Deps, rumba: RumbaConfig, state: TicketState, sha: string, lock: Lock): Promise<Verdict> {
  const first = await verifyOnce(deps, rumba, state, sha, lock)
  if (first.kind === 'passed' || first.kind === 'guard') return first
  return verifyOnce(deps, rumba, state, sha, lock)
}

/**
 * In a new checkout of the committed fix: compares the check files with the lock's hashes,
 * then runs the checks and the project tests. A changed check file is reset off the branch,
 * to the lock's commit.
 */
export async function verifyOnce(deps: Deps, rumba: RumbaConfig, state: TicketState, sha: string, lock: Lock): Promise<Verdict> {
  // The environment never runs where the agent wrote, and nothing it leaves behind is committed.
  const { workdir } = await deps.workspace.prepare(state.branch!, { fresh: false })
  try {
    // Hashed in the checkout that runs, so what is compared is what would be executed.
    const edited = changedChecks(lock.hashes, await deps.workspace.hashFiles(workdir, lock.files))
    if (edited.length > 0) {
      await deps.workspace.reset(workdir, lock.resetTo)
      return { kind: 'guard', failures: [{ criterionId: 'guard', output: `The fix changed or deleted check files, which must stay as written: ${edited.join(', ')}` }] }
    }

    const handle = await deps.environment.up({ branch: state.branch!, sha, role: 'after', timeoutMs: timeLeft(deps) }, workdir)
    try {
      return await runAll(deps, rumba, state, handle)
    } finally {
      await downQuietly(deps.environment, handle)
    }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

async function runAll(deps: Deps, rumba: RumbaConfig, state: TicketState, handle: EnvHandle): Promise<Verdict> {
  const results: CheckResult[] = []
  const max = checkOutputMax(state.checks.length)
  for (const check of state.checks) {
    const r = await deps.environment.runCheck(handle, check)
    results.push({ ...r, output: cleanOutput(r.output, deps.secrets, max) })
  }
  const infra = results.find((r) => !r.passed && r.infrastructure)
  if (infra) {
    return { kind: 'infrastructure', results, projectTests: 'not-run', reason: `The check for ${infra.criterionId} failed because ${infra.infrastructure}.`, tail: tailOf(infra.output, deps) }
  }
  // A check that timed out, cannot execute or was not found says nothing about the fix.
  const broken = results.find((r) => COULD_NOT_RUN.includes(r.exitCode))
  if (broken) throw new Error(`Check for ${broken.criterionId} could not run (exit ${broken.exitCode}): ${broken.output}`)
  const failed = fromResults(results, deps.secrets)
  if (failed.length > 0) {
    return { kind: 'checks-failed', results, projectTests: 'not-run', failures: failed, tail: tailOf(failed.map((f) => `${f.criterionId}:\n${f.output}`).join('\n\n'), deps) }
  }

  if (!rumba.verify.test) return { kind: 'passed', results, projectTests: 'not-run' }
  const ran = await deps.environment.runCommand(handle, rumba.verify.test)
  if (ran === null) return { kind: 'passed', results, projectTests: 'not-run' }
  if (ran.exitCode === 0) return { kind: 'passed', results, projectTests: 'passed' }
  if (ran.infrastructure) {
    return { kind: 'infrastructure', results, projectTests: 'infrastructure', reason: `The project tests (${rumba.verify.test}) failed because ${ran.infrastructure}.`, tail: tailOf(ran.output, deps) }
  }
  // Tests that cannot run or are not found say nothing about the fix.
  if (COULD_NOT_RUN.includes(ran.exitCode)) {
    throw new Error(`The project tests could not run (exit ${ran.exitCode}): ${cleanOutput(ran.output, deps.secrets)}`)
  }
  const output = cleanOutput(ran.output, deps.secrets)
  return { kind: 'project-tests-failed', results, projectTests: 'failed', failures: [{ criterionId: 'project-tests', output }], tail: tailOf(output, deps) }
}

function tailOf(text: string, deps: Deps): string {
  return cleanOutput(text, deps.secrets, ATTEMPT_TAIL)
}

/** Protected paths in git's list of committed changes since `since` (for a fix, the checks commit). */
export async function protectedFailure(deps: Deps, rumba: RumbaConfig, workdir: string, since: string): Promise<string | null> {
  const touched = protectedViolations(await deps.workspace.changedFiles(workdir, since), rumba.environment.protected)
  return touched.length > 0 ? `The fix changed protected paths, which the agent must not change: ${touched.join(', ')}` : null
}
