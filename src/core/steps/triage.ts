import type { RumbaConfig } from '../../config/load.js'
import type { AgentTask } from '../../ports/agent.js'
import type { Deps } from '../../ports/deps.js'
import { extractAcceptanceCriteria } from '../criteria.js'
import { fixBranch } from '../labels.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'
import { cleanupQuietly } from './teardown.js'

export async function triage(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  let current = transition(state, 'triaged', deps.clock())
  await deps.tracker.writeState(ticket, current)

  const { workdir } = await deps.workspace.prepare(fixBranch(rumba.name, ticket.id), { fresh: true })
  try {
    const documents = await deps.tracker.readLinkedDocuments(ticket)
    const task = (kind: AgentTask['kind']): AgentTask => ({
      kind, ticket, context: rumba.context, environmentKind: rumba.environment.kind, documents,
    })

    const result = await deps.agent.run(task('triage'), workdir)
    if (result.kind !== 'triage') throw new Error(`Agent returned ${result.kind} for a triage task`)

    if (!result.workable) {
      await deps.tracker.comment(ticket, `Rumba skipped this ticket: ${result.reason}`)
      current = transition(current, 'skipped', deps.clock(), result.reason)
      await deps.tracker.writeState(ticket, current)
      return current
    }

    const written = extractAcceptanceCriteria(ticket.body)
    const agentCriteria = result.criteria !== null && result.criteria.length > 0 ? result.criteria : null
    const criteria = written ?? agentCriteria
    if (criteria) {
      current = { ...transition(current, 'criteria_ready', deps.clock()), kind: result.ticketKind, criteria }
      await deps.tracker.writeState(ticket, current)
      return current
    }

    const drafted = await deps.agent.run(task('draft-criteria'), workdir)
    if (drafted.kind !== 'draft-criteria' || drafted.criteria.length === 0) {
      throw new Error('Agent did not draft any acceptance criteria')
    }
    // A label left from an earlier draft must not approve this one.
    if (ticket.labels.includes(rumba.labels.approved)) {
      await deps.tracker.removeLabel(ticket, rumba.labels.approved)
    }
    await deps.tracker.postCriteria(ticket, drafted.criteria)
    current = { ...transition(current, 'awaiting_criteria', deps.clock()), kind: result.ticketKind, criteria: drafted.criteria }
    await deps.tracker.writeState(ticket, current)
    return current
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}
