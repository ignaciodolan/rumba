import type { RumbaConfig } from '../../config/load.js'
import type { LabelAdded, PullRequestInfo } from '../../ports/codeHost.js'
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

/** Whether the revise label counts: added after the last push by a writer who is not Rumba's own account. */
function labelStartsRound(added: LabelAdded | null, pushedAt: string): boolean {
  return added !== null && Date.parse(added.at) > Date.parse(pushedAt) && added.canWrite && !added.self
}

/** Starts a revision round when a writer asked for changes or put the revise label on; otherwise changes nothing. */
async function startRound(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, url: string, labels: string[]): Promise<TicketState> {
  const label = rumba.labels.revise
  const pushedAt = lastPush(state)
  const { requested, feedback } = selectFeedback(await deps.codeHost.listFeedback(url, pushedAt), deps.secrets)
  const added = labels.includes(label) ? await deps.codeHost.labelAdded(url, label) : null
  const asked = labelStartsRound(added, pushedAt)
  // A label from before the push was dealt with by that push; one from a non-writer is left for a writer to judge.
  const stale = added !== null && Date.parse(added.at) <= Date.parse(pushedAt)
  if (!asked && !requested) {
    if (stale) await dropLabel(deps, url, label)
    return state
  }

  const next = { ...transition(state, 'changes_requested', deps.clock(), 'review feedback'), feedback }
  // Write before touching the label or commenting, so a failure there cannot lose the round.
  await deps.tracker.writeState(ticket, next)
  if (asked || stale) await dropLabel(deps, url, label)
  const count = feedback.length === 1 ? '1 comment' : `${feedback.length} comments`
  const note = feedback.length === 0
    ? `Rumba was asked to revise the change on the pull request. It will do so on a later run: ${url}`
    : `Review feedback arrived on the pull request (${count}). Rumba will revise the change on a later run: ${url}`
  try {
    await deps.tracker.comment(ticket, note)
  } catch {
    // The state already shows the round; only the courtesy note is lost.
  }
  return next
}

/** Removes the revise label, ignoring errors: a throw would reach the runner's error path, which counts an error and can overwrite the state with needs_human. */
async function dropLabel(deps: Deps, url: string, label: string): Promise<void> {
  try {
    await deps.codeHost.removeLabel(url, label)
  } catch {
    // The label stays; a later run tries again or a person removes it.
  }
}
