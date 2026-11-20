import type { RumbaConfig } from '../../config/load.js'
import type { AgentTask } from '../../ports/agent.js'
import type { Deps } from '../../ports/deps.js'
import { extractAcceptanceCriteria } from '../criteria.js'
import { fixBranch } from '../labels.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'
import { cleanupQuietly } from './teardown.js'

/** The agent writes the skip reason, so it is cut before it is posted and stored. */
const MAX_REASON = 1000

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
      const reason = result.reason.slice(0, MAX_REASON)
      await deps.tracker.comment(ticket, `Rumba skipped this ticket: ${reason}`)
      current = transition(current, 'skipped', deps.clock(), reason)
      await deps.tracker.writeState(ticket, current)
      return current
    }

    // Criteria written in the description always win.
    const kind = result.ticketKind
    const fromDescription = extractAcceptanceCriteria(ticket.body)
    const agentCriteria = result.criteria !== null && result.criteria.length > 0 ? result.criteria : null
    // A bug's one criterion comes from the report. A feature skips approval only when its
    // criteria were written by people; criteria the agent wrote itself wait for a person.
    const approved = fromDescription ?? (agentCriteria && (kind === 'bug' || result.criteriaSource === 'written') ? agentCriteria : null)
    if (approved) {
      current = { ...transition(current, 'criteria_ready', deps.clock()), kind, criteria: approved }
      await deps.tracker.writeState(ticket, current)
      return current
    }

    let draft = agentCriteria
    if (draft === null) {
      const drafted = await deps.agent.run(task('draft-criteria'), workdir)
      if (drafted.kind !== 'draft-criteria' || drafted.criteria.length === 0) {
        throw new Error('Agent did not draft any acceptance criteria')
      }
      draft = drafted.criteria
    }
    // A label left from an earlier draft must not approve this one.
    if (ticket.labels.includes(rumba.labels.approved)) {
      await deps.tracker.removeLabel(ticket, rumba.labels.approved)
    }
    await deps.tracker.postCriteria(ticket, draft)
    current = { ...transition(current, 'awaiting_criteria', deps.clock()), kind, criteria: draft }
    await deps.tracker.writeState(ticket, current)
    return current
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}
