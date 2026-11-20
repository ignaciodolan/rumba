export interface PullRequestDraft {
  title: string
  body: string
  head: string
  base: string
  draft: boolean
}

export interface CodeHost {
  defaultBranch(): Promise<string>
  /** Pushes the workdir's HEAD to the remote branch of that name. */
  pushBranch(workdir: string, branch: string, opts?: { force?: boolean }): Promise<void>
  deleteBranch(branch: string): Promise<void>
  openPullRequest(pr: PullRequestDraft): Promise<string>
}
