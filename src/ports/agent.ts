import type { Check, Criterion, Kind, LinkedDocument, Move, ProjectTestsResult, Ticket } from '../core/types.js'

export type AgentTaskKind = 'triage' | 'draft-criteria' | 'write-checks' | 'fix' | 'relocate-checks'

export interface AgentTask {
  kind: AgentTaskKind
  ticket: Ticket
  context: string
  environmentKind: 'docker' | 'vercel-preview'
  documents?: LinkedDocument[]
  criteria?: Criterion[]
  checks?: Check[]
  /** Also carries guard violations, criterionId 'guard'. */
  failures?: { criterionId: string; output: string }[]
  /** Fix tasks: files whose content Rumba guards, which the agent must not change. Relocate tasks: check files that were in the repository before Rumba's checks, which stay where they are. */
  lockedFiles?: string[]
  /** Docker environments: the prefix Rumba puts before `sh -c '<check>'` to run a check in the project's container. */
  execPrefix?: string
  /** The time the ticket has left; the call is stopped once it is spent. */
  timeoutMs?: number
  /** Fix tasks: which attempt this is, from 1. */
  attempt?: number
  /** Fix tasks: how each check did in the last run. */
  checkStatus?: { criterionId: string; passed: boolean }[]
  /** Fix tasks: how the project's own tests did in the last run. */
  projectTests?: ProjectTestsResult
}

export type AgentResult = AgentResultBody & {
  /** The last part of what the agent printed, for the run's records. Never stored on the ticket. */
  transcript?: string
}

export type AgentResultBody =
  | {
    kind: 'triage'; workable: boolean; reason: string; ticketKind: Kind; criteria: Criterion[] | null
    /** 'written': copied from the ticket, a file it names or a document. 'derived': the agent's own wording. */
    criteriaSource?: 'written' | 'derived'
    /** Written criteria, by id, that a command cannot check, each with the reason. */
    notCheckable?: { id: string; reason: string }[]
  }
  | { kind: 'draft-criteria'; criteria: Criterion[] }
  | { kind: 'write-checks'; checks: Check[] }
  | {
    kind: 'fix'; summary: string
    /** Set when the agent found no change was needed; the reason. */
    noChangeNeeded?: string
  }
  | {
    kind: 'relocate-checks'
    /** Every check file, from where Rumba wrote it to where it now lives. */
    moves: Move[]
    /** The checks as they run from their new place. */
    checks: Check[]
  }

export interface Agent {
  run(task: AgentTask, workdir: string): Promise<AgentResult>
}

export class AgentError extends Error {}
