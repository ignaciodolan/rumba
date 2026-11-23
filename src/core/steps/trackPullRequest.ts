import type { RumbaConfig } from '../../config/load.js'
import type { Deps } from '../../ports/deps.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'

/** Reads the ticket's pull request and, once it has ended, moves the ticket to match. */
export async function trackPullRequest(deps: Deps, _rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'pr_open') throw new Error(`Cannot track a pull request from state ${state.state}`)
  const url = state.pullRequestUrl
  if (!url) throw new Error('Cannot track a pull request without its url')

  const pr = await deps.codeHost.getPullRequest(url)
  if (pr.state === 'open') return state

  const merged = pr.state === 'merged'
  const when = merged ? pr.mergedAt : pr.closedAt
  const word = merged ? 'merged' : 'closed'
  const next = transition(state, merged ? 'merged' : 'rejected', deps.clock(), when === undefined ? word : `${word} at ${when}`)
  // Write before commenting, so a failed comment cannot leave the ticket looking open.
  await deps.tracker.writeState(ticket, next)
  await deps.tracker.comment(ticket, merged ? `The pull request was merged: ${url}` : `The pull request was closed without merging: ${url}`)
  return next
}
