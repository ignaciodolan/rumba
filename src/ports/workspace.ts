export interface Workspace {
  /**
   * fresh: recreate from the default branch head. Not fresh: check out the existing branch;
   * after a cleanup, the new checkout holds exactly the branch's committed tree. `like`, with
   * fresh: start from the default-branch commit that branch `like` started from, not from
   * the default branch's head now.
   */
  prepare(branch: string, opts: { fresh: boolean; like?: string }): Promise<{ workdir: string; baseSha: string }>
  /** Null when there is nothing to commit, unless `allowEmpty` asks for a commit anyway. */
  commit(workdir: string, message: string, opts?: { allowEmpty?: boolean }): Promise<string | null>
  reset(workdir: string, sha: string): Promise<void>
  /** The commit the workdir's branch points at. */
  head(workdir: string): Promise<string>
  changedFiles(workdir: string, sinceSha: string): Promise<string[]>
  hashFiles(workdir: string, files: string[]): Promise<Record<string, string>>
  /**
   * A file's text as commit `sha` holds it, read from the repository's objects, never from the
   * workdir. Null when the commit has no regular file at that path (none, a link, a folder).
   */
  readFileAt(workdir: string, sha: string, file: string): Promise<string | null>
  /** Sets `files` in the workdir and its index to their content at `sha`; a file `sha` does not have is deleted. */
  checkoutFiles(workdir: string, sha: string, files: string[]): Promise<void>
  /** Never throws: a workdir that cannot be removed is left behind, and its branch is freed. */
  cleanup(workdir: string): Promise<void>
  /** Removes every worktree this instance created. */
  cleanupAll(): Promise<void>
}
