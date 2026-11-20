export interface Workspace {
  /** fresh: recreate from the default branch head. */
  prepare(branch: string, opts: { fresh: boolean }): Promise<{ workdir: string; baseSha: string }>
  /** Null when there is nothing to commit. */
  commit(workdir: string, message: string): Promise<string | null>
  reset(workdir: string, sha: string): Promise<void>
  changedFiles(workdir: string, sinceSha: string): Promise<string[]>
  hashFiles(workdir: string, files: string[]): Promise<Record<string, string>>
  cleanup(workdir: string): Promise<void>
  /** Removes every worktree this instance created. */
  cleanupAll(): Promise<void>
}
