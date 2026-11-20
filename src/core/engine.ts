import type { RumbaConfig } from '../config/load.js'
import type { Deps } from '../ports/deps.js'
import { ENDS, transition } from './states.js'
import { build } from './steps/build.js'
import { openPullRequest } from './steps/openPullRequest.js'
import { reproduce } from './steps/reproduce.js'
import { resumeCriteria } from './steps/resumeCriteria.js'
import { triage } from './steps/triage.js'
import type { Ticket, TicketState } from './types.js'

/** Drives one ticket through the steps until it ends, waits for a person, or opens its pull request. */
export async function advanceTicket(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  const started = deps.clock().getTime()
  const budgetMs = rumba.limits.minutesPerTicket * 60_000
  let current = state
  try {
    for (;;) {
      if (ENDS.includes(current.state) || current.state === 'pr_open') return current

      if (deps.clock().getTime() - started > budgetMs) {
        await deps.tracker.comment(ticket, `Rumba stopped work on this ticket: the time budget of ${rumba.limits.minutesPerTicket} minutes ran out.`)
        current = transition(current, 'needs_human', deps.clock(), 'time budget exceeded')
        await deps.tracker.writeState(ticket, current)
        return current
      }

      switch (current.state) {
        case 'queued': current = await triage(deps, rumba, ticket, current); break
        case 'awaiting_criteria': {
          const next = await resumeCriteria(deps, rumba, ticket, current)
          if (next.state === 'awaiting_criteria') return next
          current = next
          break
        }
        case 'criteria_ready': current = await reproduce(deps, rumba, ticket, current); break
        case 'checks_failing': current = await build(deps, rumba, ticket, current); break
        case 'verified': current = await openPullRequest(deps, rumba, ticket, current); break
        default: throw new Error(`No step for state ${current.state}`)
      }
    }
  } finally {
    // Never replaces the result or the error of a step. A worktree left behind is pruned by a later prepare.
    await deps.workspace.cleanupAll().catch(() => undefined)
  }
}
