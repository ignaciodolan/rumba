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
  mergedAt?: string
  closedAt?: string
}

export interface CodeHost {
  defaultBranch(): Promise<string>
  /** Pushes the workdir's HEAD to the remote branch of that name. */
  pushBranch(workdir: string, branch: string, opts?: { force?: boolean }): Promise<void>
  deleteBranch(branch: string): Promise<void>
  openPullRequest(pr: PullRequestDraft): Promise<string>
  /** The current state of a pull request, by its URL. Throws for a URL that is not a pull request of this repository. */
  getPullRequest(url: string): Promise<PullRequestInfo>
}
