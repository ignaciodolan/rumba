import { randomUUID } from 'node:crypto'
import { execa } from 'execa'
import type { Sandbox } from '../../ports/sandbox.js'

export const SANDBOX_IMAGE = 'rumba-sandbox:local'

const TIMEOUT_EXIT_CODE = 124
const DEFAULT_KILL_GRACE_MS = 10_000

/** Runs the docker client with `args`; `env` is added to the client's own environment. */
export type DockerRunner = (args: string[], o: { env: Record<string, string> }) => Promise<{ exitCode: number; output: string }>

/**
 * Each key of `env` is passed as `-e NAME` only. Docker then takes the value from the client's
 * environment, so values never show in the host process list. Nothing else from process.env
 * reaches the container.
 */
export function dockerArgs(o: {
  workdir: string
  command: string[]
  env: Record<string, string>
  image: string
  user?: string
  name?: string
  harden?: boolean
}): string[] {
  const args = ['run', '--rm']
  if (o.user !== undefined) args.push('--user', o.user)
  if (o.name !== undefined) args.push('--name', o.name)
  if (o.harden === true) args.push('--cap-drop=ALL', '--security-opt=no-new-privileges')
  args.push('-v', `${o.workdir}:/work`, '-w', '/work')
  for (const key of Object.keys(o.env)) args.push('-e', key)
  return [...args, o.image, ...o.command]
}

/** The real runner. A client that cannot start (for example, docker is not installed) reports why in `output`. */
export function dockerRunner(binary = 'docker'): DockerRunner {
  return async (args, o) => {
    const result = await execa(binary, args, { all: true, reject: false, stdin: 'ignore', env: o.env })
    const output = result.all ?? ''
    if (result.exitCode === undefined) {
      const reason = result.shortMessage ?? result.message ?? `${binary} could not start`
      return { exitCode: 1, output: output === '' ? reason : `${output}\n${reason}` }
    }
    return { exitCode: result.exitCode, output }
  }
}

function callerUser(): string | undefined {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return undefined
  return `${process.getuid()}:${process.getgid()}`
}

function wait(ms: number): { done: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined
  const done = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  return { done, cancel: () => clearTimeout(timer) }
}

export class DockerSandbox implements Sandbox {
  private readonly image: string
  private readonly runner: DockerRunner
  private readonly killGraceMs: number

  constructor(o: { image?: string; runner?: DockerRunner; killGraceMs?: number } = {}) {
    this.image = o.image ?? SANDBOX_IMAGE
    this.runner = o.runner ?? dockerRunner()
    this.killGraceMs = o.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  }

  async run(o: { workdir: string; command: string[]; env: Record<string, string>; timeoutMs: number }): Promise<{ exitCode: number; output: string }> {
    const name = `rumba-${randomUUID()}`
    const args = dockerArgs({ ...o, image: this.image, user: callerUser(), name, harden: true })
    const running = this.runner(args, { env: o.env })

    const timeout = wait(o.timeoutMs)
    const first = await Promise.race([running, timeout.done.then(() => null)])
    timeout.cancel()
    if (first !== null) return first

    // Timed out: stop the container, then collect what it printed. A failed kill must not hide the timeout.
    await this.runner(['kill', name], { env: {} }).catch(() => undefined)
    const grace = wait(this.killGraceMs)
    const last = await Promise.race([running.catch(() => null), grace.done.then(() => null)])
    grace.cancel()
    return { exitCode: TIMEOUT_EXIT_CODE, output: last?.output ?? '' }
  }
}

/** Builds the image from `dockerfileDir` only when `docker image inspect` cannot find it. */
export async function ensureSandboxImage(image: string, dockerfileDir: string): Promise<void> {
  const inspect = await execa('docker', ['image', 'inspect', image], { reject: false })
  if (inspect.exitCode === 0) return
  const build = await execa('docker', ['build', '-t', image, dockerfileDir], { all: true, reject: false })
  if (build.exitCode !== 0) throw new Error(`docker build -t ${image} failed:\n${(build.all ?? '').slice(-2000)}`)
}
