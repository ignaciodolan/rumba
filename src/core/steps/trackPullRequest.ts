import type { RumbaConfig } from '../../config/load.js'
import type { PullRequestInfo } from '../../ports/codeHost.js'
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
  return endTicket(deps, ticket, state, url, pr)
}

/**
 * Reads the pull request of a ticket parked in `changes_requested`, and only its outcome: no feedback is
 * collected, since the ticket already holds a round. Moves the ticket once the pull request has ended.
 */
export async function trackParkedPullRequest(deps: Deps, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'changes_requested') throw new Error(`Cannot track a parked pull request from state ${state.state}`)
  const url = state.pullRequestUrl
  if (!url) throw new Error('Cannot track a pull request without its url')
  const pr = await deps.codeHost.getPullRequest(url)
  if (pr.state === 'open') return state
  return endTicket(deps, ticket, state, url, pr)
}

async function endTicket(deps: Deps, ticket: Ticket, state: TicketState, url: string, pr: PullRequestInfo): Promise<TicketState> {
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
  // The round is recorded. A throw here would reach the runner's error path, which counts an error and can
  // overwrite changes_requested with needs_human. A failed removal just leaves the label on the pull request;
  // a failed comment loses only the courtesy note.
  try {
    if (hasLabel) await deps.codeHost.removeLabel(url, label)
  } catch {
    // The label stays; the ticket has already left pr_open, so it is not read again as a new request.
  }
  const count = feedback.length === 1 ? '1 comment' : `${feedback.length} comments`
  try {
    await deps.tracker.comment(ticket, `Review feedback arrived on the pull request (${count}). Rumba will revise the change on a later run: ${url}`)
  } catch {
    // Same reason: the state already shows the round.
  }
  return next
}
