export type Kind = 'bug' | 'feature'
export type StateName =
  | 'queued' | 'triaged' | 'awaiting_criteria' | 'criteria_ready' | 'env_ready'
  | 'checks_failing' | 'building' | 'verified' | 'pr_open' | 'changes_requested'
  | 'skipped' | 'not_reproducible' | 'needs_human' | 'fix_failed'
  | 'merged' | 'rejected'
export interface Ticket { id: string; ref: string; title: string; body: string; url: string; labels: string[] }
/** `reason`: why a criterion is not checkable, when triage said so. */
export interface Criterion { id: string; text: string; checkable: boolean; reason?: string }
/** `changedAfterReview`: a review round changed this check's files; the pull request says so. */
export interface Check { criterionId: string; command: string; files: string[]; changedAfterReview?: boolean }
/** `infrastructure`: set by the environment when the run died of the machine (out of memory, full disk, a timeout), not of the code. */
export interface CheckResult { criterionId: string; passed: boolean; exitCode: number; output: string; infrastructure?: string }
/** How the project's own tests went in one attempt. */
export type ProjectTestsResult = 'passed' | 'failed' | 'infrastructure' | 'not-run'
/** One fix attempt, as recorded on the ticket so that its outcome can be explained from the ticket alone. */
export interface AttemptRecord {
  n: number
  outcome: 'verified' | 'checks-failed' | 'project-tests-failed' | 'guard' | 'no-change' | 'infrastructure'
  checks: { criterionId: string; passed: boolean; exitCode: number }[]
  projectTests: ProjectTestsResult
  note?: string
  /** A short, cleaned tail of the output that decided the outcome. */
  tail: string
}
/** One check file the relocation moved: where Rumba wrote it, and where it now lives. */
export interface Move { from: string; to: string }
/**
 * Moving Rumba's checks into the project's own tests, after the change is verified.
 * `started`: written before the agent runs, so an interrupted relocation can be undone.
 * `relocated`: kept; the ticket's checks are now the relocated ones, and `original` holds the
 * checks Rumba wrote. `rejected`: undone, for `reason`; the ticket keeps the checks Rumba wrote.
 */
export interface Relocation {
  status: 'started' | 'relocated' | 'rejected'
  /** The tip of the fix branch before the relocation: the verified change. */
  from: string
  reason?: string
  /** Relocated: the commit that moved the checks. */
  sha?: string
  moves?: Move[]
  original?: Check[]
  /** Relocated: how each relocated check did on the base commit, where it must fail. */
  before?: CheckResult[]
}
export interface LinkedDocument { title: string; body: string }
export interface LabelNames { optIn: string; statePrefix: string; approved: string; retry: string; revise: string }
/** One piece of review feedback on the pull request; `path` and `line` are set for a comment on a line. */
export interface Feedback { kind: 'review' | 'line' | 'comment'; author: string; url: string; at: string; text: string; path?: string; line?: number }
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
  /** When Rumba last pushed the fix branch. */
  pushedAt?: string
  /**
   * When the last review round that ended started, pushed or not. Feedback is read from then on,
   * so what a reviewer writes while a round runs starts the next one.
   */
  answeredAt?: string
  /** How many review rounds Rumba has run on the pull request. */
  reviewRounds?: number
  /** The review feedback collected from the pull request, while it waits for changes. */
  feedback?: Feedback[]
  before?: CheckResult[]
  after?: CheckResult[]
  /** Every fix attempt, in order. */
  attempts?: AttemptRecord[]
  /** The agent's summary of the fix that passed, for the pull request. */
  fixSummary?: string
  /** Set once Rumba tried to move the checks into the project's tests. */
  relocation?: Relocation
  lease?: { runId: string; at: string }
  history: { state: StateName; at: string; note?: string }[]
}
