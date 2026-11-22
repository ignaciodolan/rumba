import { randomUUID } from 'node:crypto'
import { execa } from 'execa'
import { type Environment, type EnvHandle, type EnvRef, InfrastructureError } from '../../ports/environment.js'
import type { DiskProbe, DockerProbe } from './dockerProbe.js'
import { classifyInfrastructure } from './infrastructure.js'
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
  /** A new checkout, in a folder of its own, of the default-branch commit that `branch` started from. */
  trustedCheckout(branch: string): Promise<string>
  /** Throws unless the checkout still holds exactly its commit. */
  verifyTrusted(dir: string): Promise<void>
  cleanup(dir: string): Promise<void>
}

/** The variable that tells the host-side commands where the commit under test is checked out. */
export const WORKDIR_VARIABLE = 'RUMBA_WORKDIR'
/**
 * Compose reads its project name from this variable. Rumba sets it, because each command runs
 * in a different folder and compose would otherwise name the project after the folder.
 */
export const PROJECT_VARIABLE = 'COMPOSE_PROJECT_NAME'

const TIMEOUT_EXIT_CODE = 124
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/** Rumba's own keys. A project's commands must not inherit them (a compose file could pass them into a container). */
const KEYS_KEPT_FROM_COMMANDS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
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
 * command ever runs in the checkout of that commit. Each runs in a trusted checkout of the
 * default-branch commit the fix branch started from, and gets the path of the commit under
 * test in `RUMBA_WORKDIR`. Whatever a command reads by relative path (compose files and what
 * they include, `.env`, a Makefile, a script, a Dockerfile) is therefore a file a person
 * merged. The code under test reaches a container only as a mount or a build context that
 * the trusted files point at `RUMBA_WORKDIR`.
 *
 * Code in a container must not be able to change what a later command reads either, and the
 * compose file may have given a container the folder `up` ran in. So no command runs in a
 * folder that existed while an earlier one ran: every `exec`, and `down`, gets a checkout
 * made for it. The folder `up` ran in is kept until `down`, because containers may have
 * files of it mounted, but nothing runs there again; if it no longer matches its commit when
 * `up` returns, the run stops.
 */
export class DockerEnvironment implements Environment {
  private readonly run: Exec
  private readonly timeoutMs: number

  constructor(private readonly o: {
    up: string; exec: string; down: string; trusted: TrustedCheckouts; run?: Exec; timeoutMs?: number
    /** Held from before `up` until after `down`, so that one environment runs at a time on the machine. */
    lock?: { acquire(timeoutMs: number): Promise<void>; release(): Promise<void> }
    /** Asked after a failed command whether Docker saw an out-of-memory kill. */
    docker?: DockerProbe
    /** Asked before `up` how much disk Docker has left. */
    disk?: DiskProbe
    minFreeBytes?: number
  }) {
    this.run = o.run ?? shellRunner
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async up(ref: EnvRef, workdir: string): Promise<EnvHandle> {
    // The ticket's deadline is fixed now, so waiting for another Rumba process's environment
    // counts toward this ticket's time and leaves less for the commands.
    const deadline = ref.timeoutMs === undefined ? undefined : Date.now() + ref.timeoutMs
    try {
      await this.o.lock?.acquire(ref.timeoutMs ?? this.timeoutMs)
    } catch (e) {
      // Another Rumba process held the machine's environment for too long: the machine, not the change.
      throw new InfrastructureError(e instanceof Error ? e.message : String(e))
    }
    try {
      await this.checkDisk()
    } catch (e) {
      await this.o.lock?.release()
      throw e
    }
    let upDir: string
    try {
      upDir = await this.o.trusted.trustedCheckout(ref.branch)
    } catch (e) {
      await this.o.lock?.release()
      throw e
    }
    const host = { branch: ref.branch, project: `rumba-${randomUUID().replaceAll('-', '').slice(0, 16)}`, upDir, deadline }
    const handle: EnvHandle = { workdir, host }
    let result: { exitCode: number; output: string; infrastructure?: string }
    try {
      const started = Date.now()
      result = await this.withDiagnosis(handle, started, await this.start(handle, upDir, this.o.up))
      // A container that `up` started may have written into the folder while `up` was still
      // reading from it. That cannot be undone, so the run stops here.
      await this.o.trusted.verifyTrusted(upDir)
    } catch (e) {
      await this.down(handle)
      throw e
    }
    if (result.exitCode !== 0) {
      await this.down(handle)
      const message = `environment up failed (exit ${result.exitCode}): ${result.output}`
      if (result.infrastructure !== undefined) throw new InfrastructureError(`The environment did not come up because ${result.infrastructure}. ${message}`)
      throw new Error(message)
    }
    return handle
  }

  async runCheck(h: EnvHandle, check: Check): Promise<CheckResult> {
    const r = await this.runInside(h, check.command)
    return { criterionId: check.criterionId, passed: r.exitCode === 0, exitCode: r.exitCode, output: r.output, ...(r.infrastructure ? { infrastructure: r.infrastructure } : {}) }
  }

  async runCommand(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string; infrastructure?: string }> {
    return this.runInside(h, command)
  }

  /** Fails before `up` when Docker has too little disk left, instead of failing later as broken tests. */
  private async checkDisk(): Promise<void> {
    if (this.o.disk === undefined || this.o.minFreeBytes === undefined) return
    const free = await this.o.disk.freeBytes().catch(() => null)
    if (free === null || free >= this.o.minFreeBytes) return
    const gb = (n: number) => (n / 2 ** 30).toFixed(1)
    throw new InfrastructureError(`Not enough disk space for Docker: ${gb(free)} GB free, at least ${gb(this.o.minFreeBytes)} GB needed. Free some with \`docker system prune\`, or give Docker a larger disk.`)
  }

  /** Adds, to a failed command's result, whether it died of the machine, asking Docker first. */
  private async withDiagnosis(
    h: EnvHandle, started: number, r: { exitCode: number; output: string },
  ): Promise<{ exitCode: number; output: string; infrastructure?: string }> {
    if (r.exitCode === 0) return r
    const dockerOom = h.host === undefined || this.o.docker === undefined ? false : await this.o.docker.outOfMemorySince(h.host.project, started).catch(() => false)
    const infrastructure = classifyInfrastructure({ exitCode: r.exitCode, output: r.output, dockerOom })
    return infrastructure === undefined ? r : { ...r, infrastructure }
  }

  /**
   * Never throws. Does nothing for a handle this environment did not bring up. The down
   * command runs in a checkout made for it; if none can be made, it does not run.
   */
  async down(h: EnvHandle): Promise<void> {
    if (h.host === undefined) return
    try {
      // Taking the environment down gets its full limit, also when the ticket's time ran out.
      await this.inNewCheckout(h, this.o.down, this.timeoutMs)
    } catch {
      // A failed teardown must not hide the result of the run.
    }
    try {
      await this.o.trusted.cleanup(h.host.upDir)
    } catch {
      // A checkout left behind is pruned by a later run.
    }
    await this.o.lock?.release().catch(() => undefined)
  }

  private async runInside(h: EnvHandle, command: string): Promise<{ exitCode: number; output: string; infrastructure?: string }> {
    const started = Date.now()
    return this.withDiagnosis(h, started, await this.inNewCheckout(h, `${this.o.exec} sh -c ${shellQuote(command)}`))
  }

  /** Runs one command in a trusted checkout made for it and removed after it. */
  private async inNewCheckout(h: EnvHandle, command: string, timeoutMs?: number): Promise<{ exitCode: number; output: string }> {
    if (h.host === undefined) throw new Error('This environment was not brought up here, so it has no trusted checkout to run host commands in.')
    const dir = await this.o.trusted.trustedCheckout(h.host.branch)
    try {
      return await this.start(h, dir, command, timeoutMs)
    } finally {
      await this.o.trusted.cleanup(dir).catch(() => undefined)
    }
  }

  /**
   * The limit of one command: the rumba's command limit, and never past the time the ticket
   * has left. Never below a second, because 0 means no limit to the runner.
   */
  private limit(h: EnvHandle): number {
    const left = h.host?.deadline === undefined ? Infinity : h.host.deadline - Date.now()
    return Math.min(this.timeoutMs, Math.max(1000, left))
  }

  /** The only place a host-side command is started: in a trusted checkout, never in `h.workdir`. */
  private start(h: EnvHandle, dir: string, command: string, timeoutMs = this.limit(h)): Promise<{ exitCode: number; output: string }> {
    return this.run(command, { cwd: dir, timeoutMs, env: { [WORKDIR_VARIABLE]: h.workdir, [PROJECT_VARIABLE]: h.host?.project ?? '' } })
  }
}
