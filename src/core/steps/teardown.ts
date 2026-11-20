import type { EnvHandle, Environment } from '../../ports/environment.js'
import type { Workspace } from '../../ports/workspace.js'

// Both ports promise not to throw from these calls. These wrappers are defence in depth: a
// teardown in a `finally` must never replace a step's result or its error.

export async function cleanupQuietly(workspace: Workspace, workdir: string): Promise<void> {
  try {
    await workspace.cleanup(workdir)
  } catch {
    // A worktree left behind is pruned or replaced by a later prepare.
  }
}

export async function downQuietly(environment: Environment, handle: EnvHandle): Promise<void> {
  try {
    await environment.down(handle)
  } catch {
    // A failed teardown must not hide the result of the run.
  }
}
