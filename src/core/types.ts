export type Kind = 'bug' | 'feature'
export type StateName =
  | 'queued' | 'triaged' | 'awaiting_criteria' | 'criteria_ready' | 'env_ready'
  | 'checks_failing' | 'building' | 'verified' | 'pr_open'
  | 'skipped' | 'not_reproducible' | 'needs_human' | 'fix_failed'
export interface Ticket { id: string; ref: string; title: string; body: string; url: string; labels: string[] }
export interface Criterion { id: string; text: string; checkable: boolean }
export interface Check { criterionId: string; command: string; files: string[] }
export interface CheckResult { criterionId: string; passed: boolean; exitCode: number; output: string }
export interface LinkedDocument { title: string; body: string }
export interface LabelNames { optIn: string; statePrefix: string; approved: string; retry: string }
export interface TicketState {
  version: 1
  rumba: string
  state: StateName
  lastDurable: StateName
  kind?: Kind
  criteria: Criterion[]
  checks: Check[]
  checkHashes: Record<string, string>
  fixAttempts: number
  errorCount: number
  branch?: string
  baseSha?: string
  checksSha?: string
  pullRequestUrl?: string
  before?: CheckResult[]
  after?: CheckResult[]
  lease?: { runId: string; at: string }
  history: { state: StateName; at: string; note?: string }[]
}
