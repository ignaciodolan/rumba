import type { RumbaConfig } from '../config/load.js'
import type { Deps } from '../ports/deps.js'
import { cleanOutput } from './redact.js'
import { ENDS, transition } from './states.js'
import { build } from './steps/build.js'
import { checkEnvironment } from './steps/checkEnvironment.js'
import { openPullRequest } from './steps/openPullRequest.js'
import { reproduce } from './steps/reproduce.js'
import { resumeCriteria } from './steps/resumeCriteria.js'
import { triage } from './steps/triage.js'
import type { Ticket, TicketState } from './types.js'

/**
 * Drives one ticket through the steps until it ends, waits for a person, or opens its pull
 * request. The ticket's time budget runs from the start of the call: every agent call and
 * environment inside a step gets at most the time left, and a step that fails once the budget
 * is spent ends the ticket in `needs_human`, not in an error.
 */
export async function advanceTicket(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  const started = deps.clock().getTime()
  const budgetMs = rumba.limits.minutesPerTicket * 60_000
  const d: Deps = { ...deps, deadline: new Date(started + budgetMs) }
  const spent = () => deps.clock().getTime() - started >= budgetMs
  let current = state
  let checked = false
  try {
    for (;;) {
      if (ENDS.includes(current.state) || current.state === 'pr_open') return current
      if (spent()) return await outOfTime(deps, rumba, ticket, current)

      try {
        switch (current.state) {
          case 'queued':
            if (!checked) {
              checked = true
              current = await checkEnvironment(d, rumba, ticket, current)
              break
            }
            current = await triage(d, rumba, ticket, current)
            break
          case 'awaiting_criteria': {
            const next = await resumeCriteria(d, rumba, ticket, current)
            if (next.state === 'awaiting_criteria') return next
            current = next
            break
          }
          case 'criteria_ready': current = await reproduce(d, rumba, ticket, current); break
          case 'checks_failing': current = await build(d, rumba, ticket, current); break
          case 'verified': current = await openPullRequest(d, rumba, ticket, current); break
          default: throw new Error(`No step for state ${current.state}`)
        }
      } catch (e) {
        // A call stopped because the ticket's time ran out is the budget, not an error. What
        // stopped the step is still said, in case it was something else.
        if (spent()) return await outOfTime(deps, rumba, ticket, current, cleanOutput(e instanceof Error ? e.message : String(e), deps.secrets, 1000))
        throw e
      }
    }
  } finally {
    // Never replaces the result or the error of a step. A worktree left behind is pruned by a later prepare.
    await deps.workspace.cleanupAll().catch(() => undefined)
  }
}

async function outOfTime(deps: Deps, rumba: RumbaConfig, ticket: Ticket, current: TicketState, lastError?: string): Promise<TicketState> {
  const because = lastError === undefined ? '' : ` The last step stopped with: ${lastError}`
  await deps.tracker.comment(ticket, `Rumba stopped work on this ticket: the time budget of ${rumba.limits.minutesPerTicket} minutes ran out.${because}`)
  const next = transition(current, 'needs_human', deps.clock(), 'time budget exceeded')
  await deps.tracker.writeState(ticket, next)
  return next
}
