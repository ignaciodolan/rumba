import { execa } from 'execa'
import type { Environment, EnvHandle } from '../../ports/environment.js'
import type { Check, CheckResult } from '../../core/types.js'

/** Runs one host-side command. `env` is added to the command's environment. */
export type Exec = (
  command: string,
  o: { cwd: string; timeoutMs: number; env?: Record<string, string> },
) => Promise<{ exitCode: number; output: string }>

/**
 * Where the host-side commands run: checkouts of code a person merged, which no agent has
 * written to. `GitWorkspace` provides them.
 */
export interface TrustedCheckouts {
  /** A new checkout of the default-branch commit that `branch` started from. */
  trustedCheckout(branch: string): Promise<string>
  cleanup(dir: string): Promise<void>
}

/** The variable that tells the host-side commands where the commit under test is checked out. */
export const WORKDIR_VARIABLE = 'RUMBA_WORKDIR'

const TIMEOUT_EXIT_CODE = 124
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Rumba's own keys. A project's commands must not inherit them (a compose file could pass them into a container). */
const KEYS_KEPT_FROM_COMMANDS = [
  'RUMBA_GITHUB_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'LINEAR_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'VERCEL_TOKEN',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
]

function commandEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !KEYS_KEPT_FROM_COMMANDS.includes(name)) env[name] = value
  }
  return env
}

/** Runs `command` through a shell in `cwd` without Rumba's keys, plus `o.env`. Stdout and stderr are captured together. */
export const shellRunner: Exec = async (command, o) => {
  const result = await execa(command, {
    shell: true,
    cwd: o.cwd,
    all: true,
    reject: false,
    stdin: 'ignore',
    // PWD names the directory the command runs in, so a compose file can refer to it as ${PWD}.
    env: { ...commandEnv(), PWD: o.cwd, ...o.env },
    extendEnv: false,
    timeout: o.timeoutMs,
  })
  const output = (result.all ?? '').trim()
  if (result.timedOut) return { exitCode: TIMEOUT_EXIT_CODE, output }
  if (result.exitCode === undefined) {
    const reason = result.shortMessage ?? result.message ?? 'command could not start'
    return { exitCode: 1, output: output === '' ? reason : `${output}\n${reason}` }
  }
  return { exitCode: result.exitCode, output }
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Brings a project up with the rumba's `up`, `exec` and `down` commands.
 *
 * Those commands run on the host, and a commit under test holds files an agent wrote. So no
 * command ever runs in the checkout of that commit: every one runs in a trusted checkout of
 * the default-branch commit the fix branch started from, and gets the path of the commit
 * under test in `RUMBA_WORKDIR`. Whatever a command reads by relative path (compose files
 * and what they include, `.env`, a Makefile, a script, a Dockerfile) is therefore a file a
 * person merged. The code under test reaches a container only as a mount or a build context
 * that the trusted files point at `RUMBA_WORKDIR`.
 */
export class DockerEnvironment implements Environment {
  private readonly run: Exec
  private readonly timeoutMs: number

  constructor(private readonly o: { up: string; exec: string; down: string; trusted: TrustedCheckouts; run?: Exec; timeoutMs?: number }) {
    this.run = o.run ?? shellRunner
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async up(ref: { branch: string; sha: string; role: 'before' | 'after' }, workdir: string): Promise<EnvHandle> {
    const hostDir = await this.o.trusted.trustedCheckout(ref.branch)
    const handle: EnvHandle = { workdir, hostDir }
    let result: { exitCode: number; output: string }
    try {
      result = await this.onHost(handle, this.o.up)
    } catch (e) {
      await this.down(handle)
      throw e
    }
    if (result.exitCode !== 0) {
      await this.down(handle)
      throw new Error(`environment up failed (exit ${result.exitCode}): ${result.output}`)
    }
    return handle
  }

  async runCheck(h: EnvHandle, check: Check): Promise<CheckResult> {
    const r = await this.runInside(h, check.command)
    return { criterionId: check.criterionId, passed: r.exitCode === 0, exitCode: r.exitCode, output: r.output }
  }

  async runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string }> {
    return this.runInside(h, command)
  }

  /** Never throws. Does nothing for a handle this environment did not bring up. */
  async down(h: EnvHandle): Promise<void> {
    if (h.hostDir === undefined) return
    try {
      await this.onHost(h, this.o.down)
    } catch {
      // A failed teardown must not hide the result of the run.
    }
    try {
      await this.o.trusted.cleanup(h.hostDir)
    } catch {
      // A checkout left behind is pruned by a later run.
    }
  }

  private runInside(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string }> {
    return this.onHost(h, `${this.o.exec} sh -c ${shellQuote(command)}`)
  }

  /** The only place a host-side command is started: always in the trusted checkout, never in `h.workdir`. */
  private async onHost(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string }> {
    if (h.hostDir === undefined) throw new Error('This environment has no trusted checkout to run host commands in; it was not brought up here.')
    return this.run(command, { cwd: h.hostDir, timeoutMs: this.timeoutMs, env: { [WORKDIR_VARIABLE]: h.workdir } })
  }
}
