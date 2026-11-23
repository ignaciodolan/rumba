import type { RumbaConfig } from '../../config/load.js'
import type { Deps } from '../../ports/deps.js'
import { selectFeedback } from '../feedback.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'

/** Reads the ticket's pull request and, once it has ended, moves the ticket to match. */
export async function trackPullRequest(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'pr_open') throw new Error(`Cannot track a pull request from state ${state.state}`)
  const url = state.pullRequestUrl
  if (!url) throw new Error('Cannot track a pull request without its url')

  const pr = await deps.codeHost.getPullRequest(url)
  if (pr.state === 'open') return startRound(deps, rumba, ticket, state, url, pr.labels)

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

/** The time of Rumba's last push: feedback older than that was already dealt with. */
function lastPush(state: TicketState): string {
  if (state.pushedAt) return state.pushedAt
  const opened = state.history.findLast((h) => h.state === 'pr_open')
  return opened ? opened.at : new Date(0).toISOString()
}

/** Starts a revision round when a writer asked for changes or put the revise label on; otherwise changes nothing. */
async function startRound(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, url: string, labels: string[]): Promise<TicketState> {
  const label = rumba.labels.revise
  const hasLabel = labels.includes(label)
  const { requested, feedback } = selectFeedback(await deps.codeHost.listFeedback(url, lastPush(state)), deps.secrets)
  if (!hasLabel && !requested) return state

  const next = { ...transition(state, 'changes_requested', deps.clock(), 'review feedback'), feedback }
  // Write before touching the label or commenting, so a failure there cannot lose the round.
  await deps.tracker.writeState(ticket, next)
  if (hasLabel) await deps.codeHost.removeLabel(url, label)
  await deps.tracker.comment(ticket, `Review feedback arrived on the pull request (${feedback.length} comments). Rumba will revise the change on a later run: ${url}`)
  return next
}
