import type { RumbaConfig } from '../../config/load.js'
import { AgentError } from '../../ports/agent.js'
import type { Deps } from '../../ports/deps.js'
import { timeLeft } from '../budget.js'
import { cleanOutput } from '../redact.js'
import { judgeRelocation, moduleVariants } from '../relocation.js'
import type { Check, CheckResult, Move, Relocation, Ticket, TicketState } from '../types.js'
import { notWhereTheAgentWrote, onTheBase, runChecks } from './baseRun.js'
import { COULD_NOT_RUN, execPrefixOf, inertTitle } from './build.js'
import { cleanupQuietly, downQuietly } from './teardown.js'

/** The longest reason kept on the ticket and put in the pull request. */
const MAX_REASON = 2000

type Outcome = { reason: string } | (Moved & { after: CheckResult[]; before: CheckResult[] })

/**
 * After the change is verified, and before the pull request: has the agent move Rumba's checks
 * into the project's own tests, then keeps the move only when Rumba can show it weakened
 * nothing. The moved lines must be the verified ones (see judgeRelocation), and each moved
 * check must pass on the change and fail on the base commit, run in the project's environment
 * like any check. Anything else undoes the move: the branch goes back to the verified change,
 * with the checks as Rumba wrote them, and the pull request says why.
 *
 * The state stays `verified`. Its `relocation` says what happened; when the move is kept, the
 * ticket's checks and their results on the change are the moved ones.
 */
export async function relocateChecks(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'verified') throw new Error(`Cannot relocate checks from state ${state.state}`)
  const { branch } = state
  if (!branch || !state.checksSha || !state.baseSha) throw new Error('Cannot relocate checks without a branch, a base commit and a checks commit')

  if (state.relocation?.status === 'started') {
    // A run stopped in the middle of a relocation: whatever it committed goes. The runner
    // makes the branch again before a ticket gets back here, which forgets the relocation;
    // this stays as a safeguard for a state that reaches this step some other way.
    const { from } = state.relocation
    await restore(deps, branch, from)
    return decide(deps, ticket, state, { status: 'rejected', from, reason: 'An earlier relocation was interrupted before Rumba could check it.' })
  }

  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  let from: string
  let moved: Moved | { reason: string }
  try {
    from = await deps.workspace.head(workdir)
    // Recorded first, so that a run that stops from here on is undone by the next one.
    await deps.tracker.writeState(ticket, { ...state, relocation: { status: 'started', from } })
    moved = await failSoft(() => move(deps, rumba, ticket, state, workdir, from))
  } finally {
    // Before anything runs: the checkouts that run get their own folder, never this one.
    await cleanupQuietly(deps.workspace, workdir)
  }
  const outcome: Outcome = 'reason' in moved ? moved : await failSoft(() => runMoved(deps, rumba, state, moved as Moved, workdir))

  if ('reason' in outcome) {
    await restore(deps, branch, from)
    return decide(deps, ticket, state, { status: 'rejected', from, reason: outcome.reason })
  }
  return decide(deps, ticket, { ...state, checks: outcome.checks, after: outcome.after }, {
    status: 'relocated', from, sha: outcome.sha, moves: outcome.moves, original: state.checks, before: outcome.before,
  })
}

async function decide(deps: Deps, ticket: Ticket, state: TicketState, relocation: Relocation): Promise<TicketState> {
  if (relocation.reason !== undefined) relocation = { ...relocation, reason: cleanOutput(relocation.reason, deps.secrets, MAX_REASON) }
  const next = { ...state, relocation }
  await deps.tracker.writeState(ticket, next)
  return next
}

/** Puts the fix branch back on the verified change. Throws when it cannot: the pull request must not hold a move Rumba rejected. */
async function restore(deps: Deps, branch: string, from: string): Promise<void> {
  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  try {
    await deps.workspace.reset(workdir, from)
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/** A step of the relocation; an error in it rejects the relocation instead of stopping the ticket. */
async function failSoft<T>(step: () => Promise<T>): Promise<T | { reason: string }> {
  try {
    return await step()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { reason: e instanceof AgentError ? `The agent could not move the checks: ${message}` : `The relocation stopped with an error: ${message}` }
  }
}

type Moved = { sha: string; moves: Move[]; checks: Check[] }

/** The agent moves the checks in `workdir`; Rumba commits the move and compares it, line by line, with what it verified. */
async function move(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, workdir: string, from: string): Promise<Moved | { reason: string }> {
  // Before the agent writes anything: what the checks commit and the fix changed since the base.
  const changedByFix = await deps.workspace.changedFiles(workdir, state.baseSha!)
  // Check files that were already on the base commit, such as a fixture an earlier ticket's
  // checks left there: other code may import them, so they stay where they are.
  // A file that cannot be read there is not guessed at: the error rejects the relocation.
  const checkFiles = [...new Set(state.checks.flatMap((c) => c.files))]
  const kept: string[] = []
  for (const f of checkFiles) if ((await deps.workspace.readFileAt(workdir, state.baseSha!, f)) !== null) kept.push(f)
  if (kept.length === checkFiles.length) return { reason: 'Every check file was already in the repository before Rumba\'s checks, so there is nothing to move.' }
  const result = await deps.agent.run({
    kind: 'relocate-checks', ticket, context: rumba.context, environmentKind: rumba.environment.kind, timeoutMs: timeLeft(deps), ...execPrefixOf(rumba),
    criteria: state.criteria, checks: state.checks, ...(kept.length > 0 ? { lockedFiles: kept } : {}),
  }, workdir)
  if (result.kind !== 'relocate-checks') throw new Error(`Agent returned ${result.kind} for a relocate-checks task`)

  const sha = await deps.workspace.commit(workdir, `test: move the checks for ${inertTitle(ticket.title)} into the project's tests (${ticket.ref})`)
  if (sha === null) return { reason: 'The agent moved nothing.' }

  // Read from the commits, never from the folder the agent wrote in.
  const changed = await deps.workspace.changedFiles(workdir, from)
  const paths = [...new Set([
    ...state.checks.flatMap((c) => c.files), ...result.moves.flatMap((m) => [m.from, m.to, ...moduleVariants(m.to)]), ...result.checks.flatMap((c) => c.files), ...changed,
  ])]
  const before: Record<string, string | null> = {}
  const after: Record<string, string | null> = {}
  for (const p of paths) {
    before[p] = await deps.workspace.readFileAt(workdir, from, p)
    after[p] = await deps.workspace.readFileAt(workdir, sha, p)
  }
  const checks = result.checks.filter((c) => state.checks.some((o) => o.criterionId === c.criterionId))
  const unlike = judgeRelocation({
    original: state.checks, moves: result.moves, relocated: result.checks, changed, before, after, protectedGlobs: rumba.environment.protected, changedByFix, kept,
  })
  if (unlike !== null) return { reason: `Rumba compared the moved checks with the ones it verified, line by line. ${unlike}` }
  return { sha, moves: result.moves, checks }
}

/** The moved checks run in the project's environment: on the change, then on the base commit. */
async function runMoved(deps: Deps, rumba: RumbaConfig, state: TicketState, moved: Moved, agentDir: string): Promise<Outcome> {
  const onChange = await onTheChange(deps, rumba, state, moved.sha, moved.checks, agentDir)
  if ('reason' in onChange) return onChange
  const onBase = await onTheBase(deps, state, {
    branch: `${state.branch!}-relocated-base`, sha: moved.sha, checks: moved.checks, files: [...new Set([...moved.moves.map((m) => m.to), ...moved.moves.map((m) => m.from)])],
    what: 'relocated', message: 'test: the relocated checks on the base commit', agentDir,
  })
  if ('reason' in onBase) return onBase
  return { ...moved, after: onChange.results, before: onBase.results }
}

/** In a new checkout of the relocation commit: every moved check passes, and so do the project's own tests. */
async function onTheChange(deps: Deps, rumba: RumbaConfig, state: TicketState, sha: string, checks: Check[], agentDir: string): Promise<{ results: CheckResult[] } | { reason: string }> {
  const { workdir } = await deps.workspace.prepare(state.branch!, { fresh: false })
  try {
    notWhereTheAgentWrote(workdir, agentDir)
    const handle = await deps.environment.up({ branch: state.branch!, sha, role: 'after', timeoutMs: timeLeft(deps) }, workdir)
    try {
      const results = await runChecks(deps, handle, checks)
      for (const r of results) {
        if (r.infrastructure) return { reason: `The relocated check for ${r.criterionId} could not be judged on the change: ${r.infrastructure}.` }
        if (COULD_NOT_RUN.includes(r.exitCode)) return { reason: `The relocated check for ${r.criterionId} could not run on the change (exit ${r.exitCode}).` }
        if (!r.passed) return { reason: `The relocated check for ${r.criterionId} fails on the change.` }
      }
      if (rumba.verify.test) {
        const ran = await deps.environment.runCommand(handle, rumba.verify.test)
        if (ran !== null && ran.exitCode !== 0) {
          return { reason: ran.infrastructure
            ? `The project's own tests could not be judged with the relocated checks in them: ${ran.infrastructure}.`
            : `The project's own tests fail with the relocated checks in them (exit ${ran.exitCode}).` }
        }
      }
      return { results }
    } finally {
      await downQuietly(deps.environment, handle)
    }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}
