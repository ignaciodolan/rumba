import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execa } from 'execa'
import type { Sandbox } from '../../ports/sandbox.js'

/** The image name used when neither an image nor a Dockerfile folder is given. */
export const SANDBOX_IMAGE = 'rumba-sandbox:local'
const DEFAULT_NODE_VERSION = '22'

/**
 * The tag of the sandbox image for a Node major version and the content of Rumba's Dockerfile.
 * A changed Dockerfile or another version gets another tag, so a stale image is never reused.
 */
export function sandboxImageTag(nodeVersion: string, dockerfile: string): string {
  const hash = createHash('sha256').update(`${nodeVersion}\0${dockerfile}`).digest('hex').slice(0, 12)
  return `rumba-sandbox:node${nodeVersion}-${hash}`
}

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

/**
 * The container the agent and URL checks run in. With `dockerfileDir` (Rumba's own `sandbox/`
 * folder, never a folder of the repository Rumba works on), the image is built from it before
 * the first run, for the Node major version given; only that version is passed in, as a build
 * argument. With `image`, that image is used as it is.
 */
export class DockerSandbox implements Sandbox {
  private image: string | undefined
  private readonly runner: DockerRunner
  private readonly killGraceMs: number
  private readonly dockerfileDir: string | undefined
  private readonly nodeVersion: string
  /** Set once the image is known to exist; cleared again when ensuring it failed. */
  private imageReady: Promise<void> | undefined

  constructor(o: { image?: string; runner?: DockerRunner; killGraceMs?: number; dockerfileDir?: string; nodeVersion?: string } = {}) {
    this.nodeVersion = o.nodeVersion ?? DEFAULT_NODE_VERSION
    if (!/^[0-9]{2,3}$/.test(this.nodeVersion)) throw new Error(`The sandbox Node version must be a major version number, not "${this.nodeVersion}".`)
    this.image = o.image ?? (o.dockerfileDir === undefined ? SANDBOX_IMAGE : undefined)
    this.runner = o.runner ?? dockerRunner()
    this.killGraceMs = o.killGraceMs ?? DEFAULT_KILL_GRACE_MS
    this.dockerfileDir = o.dockerfileDir
  }

  async run(o: { workdir: string; command: string[]; env: Record<string, string>; timeoutMs: number }): Promise<{ exitCode: number; output: string }> {
    // The limit covers the whole run, building the image included.
    const started = Date.now()
    await this.ensureImage()
    const left = o.timeoutMs - (Date.now() - started)
    if (left <= 0) return { exitCode: TIMEOUT_EXIT_CODE, output: 'The sandbox image was still being built when the time limit ran out.' }
    const name = `rumba-${randomUUID()}`
    const args = dockerArgs({ ...o, image: this.image!, user: callerUser(), name, harden: true })
    const running = this.runner(args, { env: o.env })

    const timeout = wait(left)
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

  /** Once per instance; a failure is thrown and not remembered, so the next run tries again. */
  private ensureImage(): Promise<void> {
    if (this.dockerfileDir === undefined) return Promise.resolve()
    this.imageReady ??= this.buildIfMissing(this.dockerfileDir).catch((e: unknown) => {
      this.imageReady = undefined
      throw e
    })
    return this.imageReady
  }

  /** Builds the image from `dockerfileDir` only when `docker image inspect` cannot find it. */
  private async buildIfMissing(dockerfileDir: string): Promise<void> {
    const image = this.image ?? sandboxImageTag(this.nodeVersion, await readFile(path.join(dockerfileDir, 'Dockerfile'), 'utf8'))
    const inspect = await this.runner(['image', 'inspect', image], { env: {} })
    if (inspect.exitCode !== 0) {
      const buildArgs = this.image === undefined ? ['--build-arg', `NODE_VERSION=${this.nodeVersion}`] : []
      const build = await this.runner(['build', ...buildArgs, '-t', image, dockerfileDir], { env: {} })
      if (build.exitCode !== 0) throw new Error(`docker build -t ${image} failed:\n${build.output.slice(-2000)}`)
    }
    this.image = image
  }
}
