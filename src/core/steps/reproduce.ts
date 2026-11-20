import type { RumbaConfig } from '../../config/load.js'
import type { Deps } from '../../ports/deps.js'
import { fixBranch } from '../labels.js'
import { cleanOutput } from '../redact.js'
import { transition } from '../states.js'
import type { CheckResult, Ticket, TicketState } from '../types.js'

const NO_CHECK = 'Rumba could not write a check for any criterion.'

async function stop(
  deps: Deps, ticket: Ticket, state: TicketState, to: 'needs_human' | 'not_reproducible', comment: string,
): Promise<TicketState> {
  await deps.tracker.comment(ticket, comment)
  const next = transition(state, to, deps.clock(), comment)
  await deps.tracker.writeState(ticket, next)
  return next
}

export async function reproduce(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'criteria_ready') throw new Error(`Cannot reproduce from state ${state.state}`)

  const checkable = state.criteria.filter((c) => c.checkable)
  if (checkable.length === 0) return stop(deps, ticket, state, 'needs_human', NO_CHECK)

  const branch = fixBranch(rumba.name, ticket.id)
  const { workdir, baseSha } = await deps.workspace.prepare(branch, { fresh: true })
  try {
    const result = await deps.agent.run({
      kind: 'write-checks', ticket, context: rumba.context, environmentKind: rumba.environment.kind, criteria: checkable,
    }, workdir)
    if (result.kind !== 'write-checks') throw new Error(`Agent returned ${result.kind} for a write-checks task`)

    const known = new Set(checkable.map((c) => c.id))
    const checks = result.checks.filter((c) => known.has(c.criterionId))
    if (checks.length === 0) return await stop(deps, ticket, state, 'needs_human', NO_CHECK)

    const checksSha = (await deps.workspace.commit(workdir, `test: rumba checks for ${ticket.ref}`)) ?? baseSha
    const handle = await deps.environment.up({ branch, sha: checksSha, role: 'before' }, workdir)
    try {
      let current: TicketState = {
        ...transition(state, 'env_ready', deps.clock()), branch, baseSha, checksSha, checks,
      }
      await deps.tracker.writeState(ticket, current)

      const before: CheckResult[] = []
      for (const check of checks) {
        const r = await deps.environment.runCheck(handle, check)
        before.push({ ...r, output: cleanOutput(r.output, deps.secrets) })
      }
      current = { ...current, before }

      const passing = before.filter((r) => r.passed)
      if (state.kind === 'bug' && passing.length > 0) {
        return await stop(deps, ticket, current, 'not_reproducible',
          'Rumba could not reproduce this: the check passes on the current code.')
      }
      if (passing.length > 0) {
        const texts = passing.map((r) => checkable.find((c) => c.id === r.criterionId)!.text)
        return await stop(deps, ticket, current, 'needs_human',
          `These criteria already pass on the current code: ${texts.join('; ')}`)
      }

      const checkHashes = await deps.workspace.hashFiles(workdir, checks.flatMap((c) => c.files))
      current = { ...transition(current, 'checks_failing', deps.clock()), checkHashes }
      await deps.tracker.writeState(ticket, current)
      return current
    } finally {
      await deps.environment.down(handle)
    }
  } finally {
    await deps.workspace.cleanup(workdir)
  }
}
