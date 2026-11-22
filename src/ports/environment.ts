import type { Check, CheckResult } from '../core/types.js'

export interface EnvHandle {
  /** The checkout of the commit under test. */
  workdir: string
  baseUrl?: string
  /**
   * Set by an environment that starts commands on the host, for its own use: the fix branch,
   * the name its containers share, and the trusted checkout `up` ran in. No host command
   * ever runs in `workdir`, which holds files an agent wrote.
   */
  host?: { branch: string; project: string; upDir: string; deadline?: number }
}

/**
 * What to bring up. `base`: the default branch's commit, before any agent call; `before`: the
 * checks commit; `after`: the fix. `timeoutMs`: the time the ticket has left, which no command
 * of this environment may outlast, except the one that takes it down.
 */
export interface EnvRef { branch: string; sha: string; role: 'base' | 'before' | 'after'; timeoutMs?: number }

export interface Environment {
  /**
   * `workdir` is a checkout of the commit under test, so it holds files an agent wrote. An
   * environment may hand it to a container, as a mount or a build context. It must never
   * start a host-side command in it, or one that reads from it.
   */
  up(ref: EnvRef, workdir: string): Promise<EnvHandle>
  runCheck(h: EnvHandle, check: Check): Promise<CheckResult>
  /** Null when the environment cannot run commands. */
  runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string; infrastructure?: string } | null>
  down(h: EnvHandle): Promise<void>
}

/**
 * The environment failed for a reason outside the change under test: the machine ran out of
 * memory or disk, a command was killed or timed out, or another Rumba process held the
 * environment too long. It counts as an error on the ticket, never as a fix attempt.
 */
export class InfrastructureError extends Error {}
