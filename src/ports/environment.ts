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
  host?: { branch: string; project: string; upDir: string }
}

export interface Environment {
  /**
   * `workdir` is a checkout of the commit under test, so it holds files an agent wrote. An
   * environment may hand it to a container, as a mount or a build context. It must never
   * start a host-side command in it, or one that reads from it.
   */
  up(ref: { branch: string; sha: string; role: 'before' | 'after' }, workdir: string): Promise<EnvHandle>
  runCheck(h: EnvHandle, check: Check): Promise<CheckResult>
  /** Null when the environment cannot run commands. */
  runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string } | null>
  down(h: EnvHandle): Promise<void>
}
