import type { Check, Criterion, Kind, LinkedDocument, Ticket } from '../core/types.js'

export type AgentTaskKind = 'triage' | 'draft-criteria' | 'write-checks' | 'fix'

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
  /** Fix tasks: files whose content Rumba guards, which the agent must not change. */
  lockedFiles?: string[]
  /** Docker environments: the prefix Rumba puts before `sh -c '<check>'` to run a check in the project's container. */
  execPrefix?: string
  /** The time the ticket has left; the call is stopped once it is spent. */
  timeoutMs?: number
}

export type AgentResult =
  | {
    kind: 'triage'; workable: boolean; reason: string; ticketKind: Kind; criteria: Criterion[] | null
    /** 'written': copied from the ticket, a file it names or a document. 'derived': the agent's own wording. */
    criteriaSource?: 'written' | 'derived'
    /** Written criteria, by id, that a command cannot check, each with the reason. */
    notCheckable?: { id: string; reason: string }[]
  }
  | { kind: 'draft-criteria'; criteria: Criterion[] }
  | { kind: 'write-checks'; checks: Check[] }
  | { kind: 'fix'; summary: string }

export interface Agent {
  run(task: AgentTask, workdir: string): Promise<AgentResult>
}

export class AgentError extends Error {}
