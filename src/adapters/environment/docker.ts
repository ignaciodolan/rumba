import { execa } from 'execa'
import type { Environment, EnvHandle } from '../../ports/environment.js'
import type { Check, CheckResult } from '../../core/types.js'

export type Exec = (command: string, o: { cwd: string; timeoutMs: number }) => Promise<{ exitCode: number; output: string }>

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

/** Runs `command` through a shell in `cwd` without Rumba's keys. Stdout and stderr are captured together. */
export const shellRunner: Exec = async (command, o) => {
  const result = await execa(command, {
    shell: true,
    cwd: o.cwd,
    all: true,
    reject: false,
    stdin: 'ignore',
    env: commandEnv(),
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

export class DockerEnvironment implements Environment {
  private readonly run: Exec
  private readonly timeoutMs: number

  constructor(private readonly o: { up: string; exec: string; down: string; run?: Exec; timeoutMs?: number }) {
    this.run = o.run ?? shellRunner
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async up(_ref: { branch: string; sha: string; role: 'before' | 'after' }, workdir: string): Promise<EnvHandle> {
    const result = await this.run(this.o.up, { cwd: workdir, timeoutMs: this.timeoutMs })
    if (result.exitCode !== 0) {
      await this.down({ workdir })
      throw new Error(`environment up failed (exit ${result.exitCode}): ${result.output}`)
    }
    return { workdir }
  }

  async runCheck(h: EnvHandle, check: Check): Promise<CheckResult> {
    const r = await this.runInside(h, check.command)
    return { criterionId: check.criterionId, passed: r.exitCode === 0, exitCode: r.exitCode, output: r.output }
  }

  async runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string }> {
    return this.runInside(h, command)
  }

  async down(h: EnvHandle): Promise<void> {
    try {
      await this.run(this.o.down, { cwd: h.workdir, timeoutMs: this.timeoutMs })
    } catch {
      // A failed teardown must not hide the result of the run.
    }
  }

  private runInside(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string }> {
    return this.run(`${this.o.exec} sh -c ${shellQuote(command)}`, { cwd: h.workdir, timeoutMs: this.timeoutMs })
  }
}
