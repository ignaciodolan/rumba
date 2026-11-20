import type { RumbaConfig } from '../../config/load.js'
import type { Deps } from '../../ports/deps.js'
import { extractAcceptanceCriteria } from '../criteria.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'

export async function resumeCriteria(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'awaiting_criteria') throw new Error(`Cannot resume criteria from ${state.state}`)
  if (!ticket.labels.includes(rumba.labels.approved)) return state
  const criteria = extractAcceptanceCriteria(ticket.body) ?? state.criteria
  const next = { ...transition(state, 'criteria_ready', deps.clock()), criteria }
  await deps.tracker.writeState(ticket, next)
  return next
}
