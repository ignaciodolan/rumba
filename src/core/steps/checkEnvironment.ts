import type { RumbaConfig } from '../../config/load.js'
import type { Deps } from '../../ports/deps.js'
import type { EnvHandle } from '../../ports/environment.js'
import { timeLeft } from '../budget.js'
import { fixBranch } from '../labels.js'
import { cleanOutput } from '../redact.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'
import { cleanupQuietly, downQuietly } from './teardown.js'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Before any agent call: brings the environment up once on the default branch's commit and
 * runs the project's own tests there, if the rumba names them. A project that does not start,
 * or whose tests already fail, needs a person; spending agent calls on it would only end in
 * errors, or in a fix blamed for tests that never passed. Returns the state unchanged when the
 * environment is fine, or `needs_human` with a comment saying why.
 *
 * Only for an environment that runs commands (docker). A preview environment has nothing to
 * check before a branch is pushed.
 */
export async function checkEnvironment(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'queued') throw new Error(`Cannot check the environment from state ${state.state}`)
  if (rumba.environment.kind !== 'docker') return state

  const stop = async (note: string, comment: string): Promise<TicketState> => {
    await deps.tracker.comment(ticket, comment)
    const next = transition(state, 'needs_human', deps.clock(), note)
    await deps.tracker.writeState(ticket, next)
    return next
  }

  const branch = fixBranch(rumba.name, ticket.id)
  const { workdir, baseSha } = await deps.workspace.prepare(branch, { fresh: true })
  try {
    let handle: EnvHandle
    try {
      handle = await deps.environment.up({ branch, sha: baseSha, role: 'base', timeoutMs: timeLeft(deps) }, workdir)
    } catch (e) {
      return await stop('environment did not start',
        `Rumba could not bring this project's environment up on the default branch, so it did not start work on this ticket. ` +
        `Make sure the environment's files are on the default branch and that \`up\` works there.\n\n${fence(cleanOutput(messageOf(e), deps.secrets))}`)
    }
    try {
      const test = rumba.verify.test
      if (test === undefined) return state
      const ran = await deps.environment.runCommand(handle, test)
      if (ran === null || ran.exitCode === 0) return state
      return await stop('project tests fail on the default branch',
        `The project's tests (${test}) already fail on the default branch (exit ${ran.exitCode}), so Rumba could not tell ` +
        `whether a change of its own breaks them. Rumba did not start work on this ticket.\n\n${fence(cleanOutput(ran.output, deps.secrets))}`)
    } finally {
      await downQuietly(deps.environment, handle)
    }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const f = '`'.repeat(longest + 1)
  return `${f}\n${text}\n${f}`
}
