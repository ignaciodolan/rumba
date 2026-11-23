import type { RumbaConfig } from '../config/load.js'
import type { Deps } from '../ports/deps.js'
import { LEASE_MARGIN_MINUTES } from './budget.js'
import { InfrastructureError } from '../ports/environment.js'
import { advanceTicket } from './engine.js'
import { trackPullRequest } from './steps/trackPullRequest.js'
import { cleanOutput } from './redact.js'
import { ENDS, isDurable, newState, transition } from './states.js'
import type { StateName, Ticket, TicketState } from './types.js'

export interface RunSummary {
  rumba: string
  advanced: { ticket: string; from: StateName; to: StateName }[]
  left: { ticket: string; why: string }[]
}

const MAX_ERRORS = 3
const INTERRUPTED = 'Rumba was interrupted repeatedly while working on this ticket.'

/**
 * Rumba cannot read back the state it just wrote: the account it runs as is not the account its
 * comments are attributed to. Every ticket would fail the same way, so the whole run stops.
 */
export class TrackerIdentityError extends Error {}

/** What the run has spent so far. */
interface RunCount { errors: number; worked: number }

function withoutLease(s: TicketState): TicketState {
  const { lease: _lease, ...rest } = structuredClone(s)
  return rest
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * How long a run holds a ticket: its time budget, then the time to take the environment down,
 * which runs after a ticket stops, and a margin. A run that is still working is never overtaken.
 */
function leaseMinutes(rumba: RumbaConfig): number {
  const teardown = rumba.environment.kind === 'docker' ? rumba.environment.commandTimeoutMinutes : 0
  return rumba.limits.minutesPerTicket + teardown + LEASE_MARGIN_MINUTES
}

/** The opt-in label with the rumba name removed from its end, e.g. `rumba:`. */
function optInPrefix(rumba: RumbaConfig): string {
  const { optIn } = rumba.labels
  return optIn.endsWith(rumba.name) ? optIn.slice(0, -rumba.name.length) : 'rumba:'
}

/** Lists the rumba's tickets and advances each one, within the run limits. */
export async function runRumba(deps: Deps, rumba: RumbaConfig, opts: { ticketId?: string } = {}): Promise<RunSummary> {
  await deps.tracker.ensureLabels()
  const tickets = opts.ticketId === undefined ? await deps.tracker.listCandidates({ closedIn: ['pr_open'] }) : [await deps.tracker.getTicket(opts.ticketId)]
  const summary: RunSummary = { rumba: rumba.name, advanced: [], left: [] }
  const count: RunCount = { errors: 0, worked: 0 }
  for (const ticket of tickets) {
    try {
      await handle(deps, rumba, ticket, summary, count)
    } catch (e) {
      if (e instanceof TrackerIdentityError) throw e
      summary.left.push({ ticket: ticket.id, why: `error: ${cleanOutput(messageOf(e), deps.secrets)}` })
    }
  }
  return summary
}

async function handle(deps: Deps, rumba: RumbaConfig, ticket: Ticket, summary: RunSummary, count: RunCount): Promise<void> {
  const left = (why: string): void => { summary.left.push({ ticket: ticket.id, why }) }
  const { labels, limits } = rumba

  if (!ticket.labels.includes(labels.optIn)) return left('no opt-in label')
  const prefix = optInPrefix(rumba)
  if (ticket.labels.some((l) => l.startsWith(prefix) && l !== labels.optIn)) {
    await deps.tracker.commentOnce(ticket, 'conflict', 'This ticket carries more than one rumba label, so no rumba will take it. Leave exactly one.')
    return left('two rumbas')
  }

  const stored = await deps.tracker.readState(ticket)
  let state = stored !== null && stored.rumba === rumba.name ? stored : newState(rumba.name, deps.clock())

  if (ticket.labels.includes(labels.retry) && (ENDS.includes(state.state) || state.state === 'pr_open')) {
    // A retry starts the attempts again; the old ones would explain nothing about the new run.
    const { attempts: _attempts, fixSummary: _summary, relocation: _relocation, ...rest } = state
    state = { ...transition(rest, 'queued', deps.clock()), fixAttempts: 0, errorCount: 0 }
    await deps.tracker.writeState(ticket, state)
    await deps.tracker.removeLabel(ticket, labels.retry)
  }

  if (!isDurable(state.state)) {
    const ageMs = state.lease === undefined ? Infinity : deps.clock().getTime() - new Date(state.lease.at).getTime()
    if (ageMs <= leaseMinutes(rumba) * 60_000) return left('in progress elsewhere')
    // An earlier run died while working on the ticket. That counts as one error.
    state = { ...withoutLease(state), state: state.lastDurable, errorCount: state.errorCount + 1 }
    if (state.errorCount >= MAX_ERRORS) {
      await deps.tracker.comment(ticket, INTERRUPTED)
      state = transition(state, 'needs_human', deps.clock(), 'interrupted repeatedly')
      await deps.tracker.writeState(ticket, state)
      return left(state.state)
    }
  }

  if (ENDS.includes(state.state)) return left(state.state)
  if (state.state === 'pr_open') return await checkPullRequest(deps, rumba, ticket, state, summary, count)
  if (count.worked + count.errors >= limits.maxTicketsPerRun) return left('run limit')

  const from = state.state
  state = { ...state, lease: { runId: deps.runId, at: deps.clock().toISOString() } }
  await deps.tracker.writeState(ticket, state)
  if ((await deps.tracker.readState(ticket)) === null) {
    throw new TrackerIdentityError(
      `Rumba cannot read the state it just wrote on ticket ${ticket.ref}: the account it runs as does not match ` +
      'the account its comments are attributed to. Set RUMBA_GITHUB_LOGIN to the login that posts Rumba\'s comments.',
    )
  }

  let result: TicketState
  try {
    result = await advanceTicket(deps, rumba, ticket, state)
  } catch (e) {
    return left(await recordError(deps, ticket, state, e, count))
  }

  await deps.tracker.writeState(ticket, withoutLease(result))
  if (result.state === 'awaiting_criteria') return left('awaiting criteria')
  count.worked += 1
  summary.advanced.push({ ticket: ticket.id, from, to: result.state })
}

/**
 * Reads the pull request of a ticket in `pr_open`. It needs no lease and no engine, so it does not
 * count toward the run limit; only a failed read does, like any other error.
 */
async function checkPullRequest(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState, summary: RunSummary, count: RunCount): Promise<void> {
  try {
    const next = await trackPullRequest(deps, rumba, ticket, state)
    if (next.state === state.state) summary.left.push({ ticket: ticket.id, why: 'pull request open' })
    else summary.advanced.push({ ticket: ticket.id, from: state.state, to: next.state })
  } catch (e) {
    summary.left.push({ ticket: ticket.id, why: await recordError(deps, ticket, state, e, count) })
  }
}

/** Counts one error on the ticket and returns it to its last durable state; returns the summary line. */
async function recordError(deps: Deps, ticket: Ticket, state: TicketState, e: unknown, count: RunCount): Promise<string> {
  count.errors += 1
  const message = cleanOutput(messageOf(e), deps.secrets)
  const current = (await deps.tracker.readState(ticket)) ?? state
  let next: TicketState = { ...withoutLease(current), state: current.lastDurable, errorCount: current.errorCount + 1 }
  if (next.errorCount >= MAX_ERRORS) {
    next = transition(next, 'needs_human', deps.clock(), 'repeated errors')
    await deps.tracker.comment(ticket, `Rumba hit repeated errors on this ticket: ${message}`)
  } else if (e instanceof InfrastructureError) {
    // Say plainly that it was the machine, so nobody reads it as a problem with the change.
    await deps.tracker.comment(ticket,
      `Rumba stopped because of a problem with the machine, not with the change: ${message} ` +
      `This counts as error ${next.errorCount} of ${MAX_ERRORS}, not as a fix attempt. The next run tries again.`)
  }
  await deps.tracker.writeState(ticket, next)
  return `error: ${message}`
}
