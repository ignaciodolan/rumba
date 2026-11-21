import type { RumbaConfig } from '../../config/load.js'
import type { AgentTask } from '../../ports/agent.js'
import type { Deps } from '../../ports/deps.js'
import { timeLeft } from '../budget.js'
import { extractAcceptanceCriteria } from '../criteria.js'
import { fixBranch } from '../labels.js'
import { redact } from '../redact.js'
import { transition } from '../states.js'
import type { Criterion, Ticket, TicketState } from '../types.js'
import { cleanupQuietly } from './teardown.js'

/** The agent writes the skip reason, so it is cut before it is posted and stored. */
const MAX_REASON = 1000

export async function triage(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  let current = transition(state, 'triaged', deps.clock())
  await deps.tracker.writeState(ticket, current)

  const { workdir } = await deps.workspace.prepare(fixBranch(rumba.name, ticket.id), { fresh: true })
  try {
    const documents = await deps.tracker.readLinkedDocuments(ticket)
    // Criteria written in the description always win. Triage sees them, with their ids, so it
    // can say which of them a command cannot check.
    const fromDescription = extractAcceptanceCriteria(ticket.body)
    const task = (kind: AgentTask['kind']): AgentTask => ({
      kind, ticket, context: rumba.context, environmentKind: rumba.environment.kind, documents, timeoutMs: timeLeft(deps),
      ...(kind === 'triage' && fromDescription ? { criteria: fromDescription } : {}),
    })

    const result = await deps.agent.run(task('triage'), workdir)
    if (result.kind !== 'triage') throw new Error(`Agent returned ${result.kind} for a triage task`)

    if (!result.workable) {
      // Redact before cutting: a secret cut in two could no longer be matched.
      const reason = redact(result.reason, deps.secrets).slice(0, MAX_REASON)
      await deps.tracker.comment(ticket, `Rumba skipped this ticket: ${reason}`)
      current = transition(current, 'skipped', deps.clock(), reason)
      await deps.tracker.writeState(ticket, current)
      return current
    }

    const kind = result.ticketKind
    const written = fromDescription === null ? null : markNotCheckable(fromDescription, result.notCheckable ?? [])
    const agentCriteria = result.criteria !== null && result.criteria.length > 0 ? result.criteria : null
    // A bug's one criterion comes from the report. A feature skips approval only when its
    // criteria were written by people; criteria the agent wrote itself wait for a person.
    const approved = written ?? (agentCriteria && (kind === 'bug' || result.criteriaSource === 'written') ? agentCriteria : null)
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

/** The reason triage gives is cut, since it is posted in the pull request. */
const MAX_NOT_CHECKABLE_REASON = 300

/**
 * Written criteria with those triage named marked not checkable, with its reason. The wording
 * of a criterion never changes, and an id that names no written criterion is ignored.
 */
function markNotCheckable(written: Criterion[], notCheckable: { id: string; reason: string }[]): Criterion[] {
  const reasons = new Map(notCheckable.map((n) => [n.id, n.reason.trim().slice(0, MAX_NOT_CHECKABLE_REASON)]))
  return written.map((c) => {
    const reason = reasons.get(c.id)
    return reason ? { ...c, checkable: false, reason } : c
  })
}
