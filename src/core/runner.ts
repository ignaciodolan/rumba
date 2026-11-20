import type { RumbaConfig } from '../config/load.js'
import type { Deps } from '../ports/deps.js'
import { advanceTicket } from './engine.js'
import { cleanOutput } from './redact.js'
import { ENDS, isDurable, newState, transition } from './states.js'
import type { StateName, Ticket, TicketState } from './types.js'

export interface RunSummary {
  rumba: string
  advanced: { ticket: string; from: StateName; to: StateName }[]
  left: { ticket: string; why: string }[]
}

const MAX_ERRORS = 3

function withoutLease(s: TicketState): TicketState {
  const { lease: _lease, ...rest } = structuredClone(s)
  return rest
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** The opt-in label with the rumba name removed from its end, e.g. `rumba:`. */
function optInPrefix(rumba: RumbaConfig): string {
  const { optIn } = rumba.labels
  return optIn.endsWith(rumba.name) ? optIn.slice(0, -rumba.name.length) : 'rumba:'
}

/** Lists the rumba's tickets and advances each one, within the run limits. */
export async function runRumba(deps: Deps, rumba: RumbaConfig, opts: { ticketId?: string } = {}): Promise<RunSummary> {
  await deps.tracker.ensureLabels()
  const tickets = opts.ticketId === undefined ? await deps.tracker.listCandidates() : [await deps.tracker.getTicket(opts.ticketId)]
  const summary: RunSummary = { rumba: rumba.name, advanced: [], left: [] }
  for (const ticket of tickets) {
    try {
      await handle(deps, rumba, ticket, summary)
    } catch (e) {
      summary.left.push({ ticket: ticket.id, why: `error: ${cleanOutput(messageOf(e), deps.secrets)}` })
    }
  }
  return summary
}

async function handle(deps: Deps, rumba: RumbaConfig, ticket: Ticket, summary: RunSummary): Promise<void> {
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
    state = { ...transition(state, 'queued', deps.clock()), fixAttempts: 0, errorCount: 0 }
    await deps.tracker.writeState(ticket, state)
    await deps.tracker.removeLabel(ticket, labels.retry)
  }

  if (!isDurable(state.state)) {
    const ageMs = state.lease === undefined ? Infinity : deps.clock().getTime() - new Date(state.lease.at).getTime()
    if (ageMs <= limits.minutesPerTicket * 60_000) return left('in progress elsewhere')
    state = { ...withoutLease(state), state: state.lastDurable }
  }

  if (ENDS.includes(state.state) || state.state === 'pr_open') return left(state.state)
  if (summary.advanced.length >= limits.maxTicketsPerRun) return left('run limit')

  const from = state.state
  state = { ...state, lease: { runId: deps.runId, at: deps.clock().toISOString() } }
  await deps.tracker.writeState(ticket, state)

  let result: TicketState
  try {
    result = await advanceTicket(deps, rumba, ticket, state)
  } catch (e) {
    const message = cleanOutput(messageOf(e), deps.secrets)
    const current = (await deps.tracker.readState(ticket)) ?? state
    let next: TicketState = { ...withoutLease(current), state: current.lastDurable, errorCount: current.errorCount + 1 }
    if (next.errorCount >= MAX_ERRORS) {
      next = transition(next, 'needs_human', deps.clock(), 'repeated errors')
      await deps.tracker.comment(ticket, `Rumba hit repeated errors on this ticket: ${message}`)
    }
    await deps.tracker.writeState(ticket, next)
    return left(`error: ${message}`)
  }

  await deps.tracker.writeState(ticket, withoutLease(result))
  if (result.state === 'awaiting_criteria') return left('awaiting criteria')
  summary.advanced.push({ ticket: ticket.id, from, to: result.state })
}
