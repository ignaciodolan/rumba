import type { RumbaConfig } from '../../config/load.js'
import type { LabelAdded, PullRequestInfo } from '../../ports/codeHost.js'
import type { Deps } from '../../ports/deps.js'
import { selectFeedback } from '../feedback.js'
import { lessonBranch } from '../labels.js'
import { learn, lessonReason, lessonsPath, withLesson } from '../lessons.js'
import { transition } from '../states.js'
import type { Feedback, LessonRecord, Ticket, TicketState } from '../types.js'

const NO_FEEDBACK = 'the pull request was closed with no feedback'

/** Reads the ticket's pull request and, once it has ended, moves the ticket to match. */
export async function trackPullRequest(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'pr_open') throw new Error(`Cannot track a pull request from state ${state.state}`)
  const url = state.pullRequestUrl
  if (!url) throw new Error('Cannot track a pull request without its url')

  const pr = await deps.codeHost.getPullRequest(url)
  if (pr.state === 'open') return startRound(deps, rumba, ticket, state, url, pr.labels)
  return endTicket(deps, rumba, ticket, state, url, pr)
}

/**
 * Reads the pull request of a ticket in `changes_requested`, and only its outcome: no feedback is collected,
 * since the ticket already holds a round. Moves the ticket once the pull request has ended; while it is open,
 * the ticket is left as it is, for the round.
 */
export async function trackParkedPullRequest(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'changes_requested') throw new Error(`Cannot track a parked pull request from state ${state.state}`)
  const url = state.pullRequestUrl
  if (!url) throw new Error('Cannot track a pull request without its url')
  const pr = await deps.codeHost.getPullRequest(url)
  if (pr.state === 'open') return state
  return endTicket(deps, rumba, ticket, state, url, pr)
}

/** Moves the ticket to match the pull request's end and, when it was closed without merging, draws a lesson from its review. */
async function endTicket(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, url: string, pr: PullRequestInfo): Promise<TicketState> {
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
  // A merged change needs no lesson: the review got what it asked for.
  return merged ? next : withClosedLesson(deps, rumba, ticket, next, url)
}

/**
 * Records the lesson of a pull request closed without merging, once its outcome is recorded.
 * Never throws, for the same reason the comment above does not: the ticket has ended.
 */
async function withClosedLesson(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, url: string): Promise<TicketState> {
  const next = withLesson(state, await closedLesson(deps, rumba, ticket, state, url))
  try {
    await deps.tracker.writeState(ticket, next)
  } catch {
    // The outcome is recorded; only the lesson's record is lost.
    return state
  }
  return next
}

/**
 * The writers' feedback since Rumba first opened the pull request, drawn into a lesson. The
 * closed pull request's branch is never merged, so the lesson goes on a branch of Rumba's own,
 * made fresh from the default branch, and is offered in a pull request of its own.
 */
async function closedLesson(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, url: string): Promise<LessonRecord> {
  let feedback: Feedback[]
  try {
    feedback = selectFeedback(await deps.codeHost.listFeedback(url, openedAt(state)), deps.secrets).feedback
  } catch (e) {
    return failed(deps, 'The feedback could not be read', e)
  }
  if (feedback.length === 0) return { at: deps.clock().toISOString(), status: 'none', reason: NO_FEEDBACK }

  const branch = lessonBranch(rumba.name, ticket.id)
  // The branch is Rumba's own, made again from the default branch: a force push replaces any earlier lesson there.
  const record = await learn(deps, rumba, ticket, state, { feedback, url, branch, fresh: true, push: { force: true } })
  if (record.status !== 'added') return record
  try {
    const pullRequestUrl = await deps.codeHost.openPullRequest({
      title: `Lesson from review of ${ticket.ref} for the ${rumba.name} rumba`,
      body: `Rumba drew this lesson from the review of ${url}. Merging it adds the lesson to \`${lessonsPath(rumba.name)}\`, which the rumba reads from then on.`,
      head: branch,
      base: await deps.codeHost.defaultBranch(),
      draft: false,
    })
    return { ...record, pullRequestUrl }
  } catch (e) {
    // The lesson is pushed, so its commit is kept for a person to open the pull request from.
    return { ...failed(deps, 'The lesson pull request could not be opened', e), commit: record.commit! }
  }
}

/** When Rumba first opened the pull request: its review starts there, whatever rounds came after. */
function openedAt(state: TicketState): string {
  return state.history.find((h) => h.state === 'pr_open')?.at ?? new Date(0).toISOString()
}

function failed(deps: Deps, what: string, e: unknown): LessonRecord {
  const message = e instanceof Error ? e.message : String(e)
  return { at: deps.clock().toISOString(), status: 'failed', reason: lessonReason(`${what}: ${message}`, deps.secrets) }
}

/**
 * Feedback older than this was already dealt with: the start of the last review round, which
 * answered it whether it pushed or not, or else Rumba's push when it opened the pull request.
 * Not a round's push: feedback written while the round ran is still to be answered.
 */
export function dealtWithUntil(state: TicketState): string {
  if (state.answeredAt !== undefined) return state.answeredAt
  if (state.pushedAt) return state.pushedAt
  const opened = state.history.findLast((h) => h.state === 'pr_open')
  return opened ? opened.at : new Date(0).toISOString()
}

/**
 * Whether the revise label counts: added after the feedback was dealt with, by a writer. Rumba never adds it,
 * so one added by Rumba's own account is a maintainer using that account, and counts like anyone's.
 */
function labelStartsRound(added: LabelAdded | null, since: string): boolean {
  return added !== null && Date.parse(added.at) > Date.parse(since) && added.canWrite
}

/** Starts a revision round when a writer asked for changes or put the revise label on; otherwise changes nothing. */
async function startRound(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, url: string, labels: string[]): Promise<TicketState> {
  const label = rumba.labels.revise
  const since = dealtWithUntil(state)
  const { requested, feedback } = selectFeedback(await deps.codeHost.listFeedback(url, since), deps.secrets)
  const added = labels.includes(label) ? await deps.codeHost.labelAdded(url, label) : null
  const asked = labelStartsRound(added, since)
  // A label from before then was dealt with already; one from a non-writer is left for a writer to judge.
  const stale = added !== null && Date.parse(added.at) <= Date.parse(since)
  if (!asked && !requested) {
    if (stale) await dropLabel(deps, url, label)
    return state
  }

  const next = { ...transition(state, 'changes_requested', deps.clock(), 'review feedback'), feedback }
  // Write before touching the label or commenting, so a failure there cannot lose the round.
  await deps.tracker.writeState(ticket, next)
  if (asked || stale) await dropLabel(deps, url, label)
  const count = feedback.length === 1 ? '1 comment' : `${feedback.length} comments`
  // No promise of when: the round usually runs in this same run, but the run limit can leave it for the next.
  const note = feedback.length === 0
    ? `Rumba was asked to revise the change on the pull request and will do so: ${url}`
    : `Review feedback arrived on the pull request (${count}). Rumba will revise the change: ${url}`
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
