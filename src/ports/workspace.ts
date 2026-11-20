export interface Workspace {
  /**
   * fresh: recreate from the default branch head. Not fresh: check out the existing branch;
   * after a cleanup, the new checkout holds exactly the branch's committed tree.
   */
  prepare(branch: string, opts: { fresh: boolean }): Promise<{ workdir: string; baseSha: string }>
  /** Null when there is nothing to commit, unless `allowEmpty` asks for a commit anyway. */
  commit(workdir: string, message: string, opts?: { allowEmpty?: boolean }): Promise<string | null>
  reset(workdir: string, sha: string): Promise<void>
  changedFiles(workdir: string, sinceSha: string): Promise<string[]>
  hashFiles(workdir: string, files: string[]): Promise<Record<string, string>>
  /** Never throws: a workdir that cannot be removed is left behind, and its branch is freed. */
  cleanup(workdir: string): Promise<void>
  /** Removes every worktree this instance created. */
  cleanupAll(): Promise<void>
}
