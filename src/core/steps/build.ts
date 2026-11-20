import type { RumbaConfig } from '../../config/load.js'
import type { Deps } from '../../ports/deps.js'
import { changedChecks, protectedViolations } from '../guards.js'
import { checkOutputMax, cleanOutput } from '../redact.js'
import { transition } from '../states.js'
import type { CheckResult, Ticket, TicketState } from '../types.js'
import { cleanupQuietly, downQuietly } from './teardown.js'

type Failure = { criterionId: string; output: string }

function fromResults(results: CheckResult[], secrets: string[]): Failure[] {
  return results.filter((r) => !r.passed).map((r) => ({ criterionId: r.criterionId, output: cleanOutput(r.output, secrets) }))
}

export async function build(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'checks_failing') throw new Error(`Cannot build from state ${state.state}`)
  const { branch, checksSha } = state
  if (!branch || !checksSha) throw new Error('Cannot build without a branch and a checks commit')

  let current = transition(state, 'building', deps.clock())
  await deps.tracker.writeState(ticket, current)

  let failures: Failure[] = fromResults(state.before ?? [], deps.secrets)
  const checkFiles = [...new Set([...Object.keys(state.checkHashes), ...state.checks.flatMap((c) => c.files)])]

  while (current.fixAttempts < rumba.limits.maxFixAttempts) {
    const fixed = await fixOnce(deps, rumba, ticket, current, failures, checkFiles)
    const outcome = 'sha' in fixed ? await verify(deps, rumba, current, fixed.sha) : fixed

    if ('passed' in outcome) {
      current = { ...transition(current, 'verified', deps.clock()), after: outcome.passed }
      await deps.tracker.writeState(ticket, current)
      return current
    }
    failures = outcome.failures
    current = { ...current, fixAttempts: current.fixAttempts + 1 }
    await deps.tracker.writeState(ticket, current)
  }

  const attempts = current.fixAttempts
  const details = failures.map((f) => `${f.criterionId}:\n${f.output}`).join('\n\n')
  const comment = `Rumba could not fix this: the checks still fail after ${attempts} attempts.\n\nLast failures:\n\n${details}`
  await deps.tracker.comment(ticket, comment)
  current = transition(current, 'fix_failed', deps.clock(), `checks still fail after ${attempts} attempts`)
  await deps.tracker.writeState(ticket, current)
  return current
}

/**
 * One fix in a new worktree of the branch: the agent changes the code, Rumba commits and
 * guards the commit, and the worktree is removed. A rejected commit is reset off the branch.
 */
async function fixOnce(
  deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, failures: Failure[], checkFiles: string[],
): Promise<{ sha: string } | { failures: Failure[] }> {
  const { workdir } = await deps.workspace.prepare(state.branch!, { fresh: false })
  try {
    const result = await deps.agent.run({
      kind: 'fix', ticket, context: rumba.context, environmentKind: rumba.environment.kind,
      criteria: state.criteria, checks: state.checks, failures,
    }, workdir)
    if (result.kind !== 'fix') throw new Error(`Agent returned ${result.kind} for a fix task`)

    const sha = await deps.workspace.commit(workdir, `fix: ${ticket.title} (${ticket.ref})`)
    if (sha === null) return { failures: [{ criterionId: 'guard', output: 'The agent changed no files.' }] }
    const guard = await guardFailure(deps, rumba, workdir, state, checkFiles)
    if (guard) {
      await deps.workspace.reset(workdir, state.checksSha!)
      return { failures: [{ criterionId: 'guard', output: guard }] }
    }
    return { sha }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/** Runs the checks, then the project tests, in a new checkout of the committed fix. */
async function verify(
  deps: Deps, rumba: RumbaConfig, state: TicketState, sha: string,
): Promise<{ passed: CheckResult[] } | { failures: Failure[] }> {
  // The environment never runs where the agent wrote, and nothing it leaves behind is committed.
  const { workdir } = await deps.workspace.prepare(state.branch!, { fresh: false })
  try {
    const handle = await deps.environment.up({ branch: state.branch!, sha, role: 'after' }, workdir)
    try {
      const results: CheckResult[] = []
      const max = checkOutputMax(state.checks.length)
      for (const check of state.checks) {
        const r = await deps.environment.runCheck(handle, check)
        results.push({ ...r, output: cleanOutput(r.output, deps.secrets, max) })
      }
      const failed = fromResults(results, deps.secrets)
      if (failed.length > 0) return { failures: failed }

      if (rumba.verify.test) {
        const ran = await deps.environment.runCommand(handle, rumba.verify.test)
        if (ran !== null && ran.exitCode !== 0) {
          return { failures: [{ criterionId: 'project-tests', output: cleanOutput(ran.output, deps.secrets) }] }
        }
      }
      return { passed: results }
    } finally {
      await downQuietly(deps.environment, handle)
    }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

async function guardFailure(
  deps: Deps, rumba: RumbaConfig, workdir: string, state: TicketState, checkFiles: string[],
): Promise<string | null> {
  const touched = protectedViolations(await deps.workspace.changedFiles(workdir, state.checksSha!), rumba.environment.protected)
  if (touched.length > 0) return `The fix changed protected paths, which the agent must not change: ${touched.join(', ')}`
  const edited = changedChecks(state.checkHashes, await deps.workspace.hashFiles(workdir, checkFiles))
  if (edited.length > 0) return `The fix changed or deleted check files, which must stay as written: ${edited.join(', ')}`
  return null
}
