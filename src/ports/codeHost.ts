/**
 * The code host cannot tell which account Rumba runs as, so it cannot tell Rumba's own feedback from
 * anyone else's. A setup error, not a ticket error: every ticket would fail the same way.
 */
export class CodeHostIdentityError extends Error {}

export interface PullRequestDraft {
  title: string
  body: string
  head: string
  base: string
  draft: boolean
}

export interface PullRequestInfo {
  state: 'open' | 'merged' | 'closed'
  headSha: string
  /** The labels on the pull request, by name. */
  labels: string[]
  mergedAt?: string
  closedAt?: string
}

/** One piece of review feedback. The facts only: whether to act on it is the caller's decision. */
export interface FeedbackItem {
  kind: 'review' | 'line' | 'comment'
  author: string
  url: string
  /** When it was written, as an ISO timestamp. */
  at: string
  text: string
  path?: string
  line?: number
  reviewState?: 'changes_requested' | 'approved' | 'commented'
  /** The author has write access to the repository. False when that cannot be confirmed, and for a bot. */
  canWrite: boolean
  /** The author is the account Rumba runs as. */
  self: boolean
}

/** The latest time a label was put on a pull request, and who did it. */
export interface LabelAdded {
  by: string
  /** When, as an ISO timestamp. */
  at: string
  /** The actor has write access. False when that cannot be confirmed, and for a bot. */
  canWrite: boolean
  /** The actor is the account Rumba runs as. */
  self: boolean
}

export interface CodeHost {
  defaultBranch(): Promise<string>
  /** Pushes the workdir's HEAD to the remote branch of that name. */
  pushBranch(workdir: string, branch: string, opts?: { force?: boolean }): Promise<void>
  deleteBranch(branch: string): Promise<void>
  openPullRequest(pr: PullRequestDraft): Promise<string>
  /** The current state of a pull request, by its URL. Throws for a URL that is not a pull request of this repository. */
  getPullRequest(url: string): Promise<PullRequestInfo>
  /**
   * The reviews, line comments and comments of a pull request written strictly after `since`.
   * Throws when the account Rumba runs as cannot be determined, so nobody is wrongly taken for someone else.
   */
  listFeedback(url: string, since: string): Promise<FeedbackItem[]>
  /** When and by whom `label` was last added to the pull request; null if it never was. Same URL check as the other reads. */
  labelAdded(url: string, label: string): Promise<LabelAdded | null>
  /** Removes a label from a pull request. A label that is not there is not an error. */
  removeLabel(url: string, label: string): Promise<void>
}
