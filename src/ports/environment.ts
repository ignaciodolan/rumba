import type { Check, CheckResult } from '../core/types.js'

export interface EnvHandle {
  /** The checkout of the commit under test. */
  workdir: string
  baseUrl?: string
  /**
   * Set by an environment that starts commands on the host: the trusted checkout those
   * commands run in. It is never `workdir`, which holds files an agent wrote.
   */
  hostDir?: string
}

export interface Environment {
  up(ref: { branch: string; sha: string; role: 'before' | 'after' }, workdir: string): Promise<EnvHandle>
  runCheck(h: EnvHandle, check: Check): Promise<CheckResult>
  /** Null when the environment cannot run commands. */
  runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string } | null>
  down(h: EnvHandle): Promise<void>
}
