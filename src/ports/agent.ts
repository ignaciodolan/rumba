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
}

export type AgentResult =
  | { kind: 'triage'; workable: boolean; reason: string; ticketKind: Kind; criteria: Criterion[] | null }
  | { kind: 'draft-criteria'; criteria: Criterion[] }
  | { kind: 'write-checks'; checks: Check[] }
  | { kind: 'fix'; summary: string }

export interface Agent {
  run(task: AgentTask, workdir: string): Promise<AgentResult>
}

export class AgentError extends Error {}
