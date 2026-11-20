import { randomUUID } from 'node:crypto'
import { execa } from 'execa'
import type { Sandbox } from '../../ports/sandbox.js'

export const SANDBOX_IMAGE = 'rumba-sandbox:local'

const TIMEOUT_EXIT_CODE = 124

/** Only the keys in `env` reach the container; nothing comes from process.env. */
export function dockerArgs(o: {
  workdir: string
  command: string[]
  env: Record<string, string>
  image: string
  user?: string
  name?: string
}): string[] {
  const args = ['run', '--rm']
  if (o.user !== undefined) args.push('--user', o.user)
  if (o.name !== undefined) args.push('--name', o.name)
  args.push('-v', `${o.workdir}:/work`, '-w', '/work')
  for (const [key, value] of Object.entries(o.env)) args.push('-e', `${key}=${value}`)
  return [...args, o.image, ...o.command]
}

function callerUser(): string | undefined {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return undefined
  return `${process.getuid()}:${process.getgid()}`
}

export class DockerSandbox implements Sandbox {
  private readonly image: string

  constructor(o: { image?: string } = {}) {
    this.image = o.image ?? SANDBOX_IMAGE
  }

  async run(o: { workdir: string; command: string[]; env: Record<string, string>; timeoutMs: number }): Promise<{ exitCode: number; output: string }> {
    const name = `rumba-${randomUUID()}`
    const args = dockerArgs({ ...o, image: this.image, user: callerUser(), name })
    // Values in `env` are passed as -e KEY=VALUE arguments; the docker client process gets no extra environment.
    const subprocess = execa('docker', args, { all: true, reject: false, stdin: 'ignore' })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void execa('docker', ['kill', name], { reject: false })
    }, o.timeoutMs)
    try {
      const result = await subprocess
      const output = result.all ?? ''
      return { exitCode: timedOut ? TIMEOUT_EXIT_CODE : (result.exitCode ?? 1), output }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Builds the image from `dockerfileDir` only when `docker image inspect` cannot find it. */
export async function ensureSandboxImage(image: string, dockerfileDir: string): Promise<void> {
  const inspect = await execa('docker', ['image', 'inspect', image], { reject: false })
  if (inspect.exitCode === 0) return
  const build = await execa('docker', ['build', '-t', image, dockerfileDir], { all: true, reject: false })
  if (build.exitCode !== 0) throw new Error(`docker build -t ${image} failed:\n${(build.all ?? '').slice(-2000)}`)
}
