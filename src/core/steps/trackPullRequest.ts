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
  try {
    await deps.tracker.comment(ticket, merged ? `The pull request was merged: ${url}` : `The pull request was closed without merging: ${url}`)
  } catch {
    // The outcome is already recorded. Letting this throw would send the ticket down the runner's error
    // path, which counts an error on an ended ticket and can overwrite merged/rejected with needs_human.
    // The state comment and label already show the outcome; only the courtesy comment is lost.
  }
  return next
}
