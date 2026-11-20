import type { Check, CheckResult } from '../core/types.js'

export interface EnvHandle {
  workdir: string
  baseUrl?: string
}

export interface Environment {
  up(ref: { branch: string; sha: string; role: 'before' | 'after' }, workdir: string): Promise<EnvHandle>
  runCheck(h: EnvHandle, check: Check): Promise<CheckResult>
  /** Null when the environment cannot run commands. */
  runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string } | null>
  down(h: EnvHandle): Promise<void>
}
