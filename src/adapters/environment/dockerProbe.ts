import { execa } from 'execa'

/** What Rumba asks Docker about a project's containers. */
export interface DockerProbe {
  /** Whether Docker reported an out-of-memory kill in the project's containers since `sinceMs`. */
  outOfMemorySince(project: string, sinceMs: number): Promise<boolean>
}

/** How much disk Docker has left for images and containers, or null when it cannot be told. */
export interface DiskProbe {
  freeBytes(): Promise<number | null>
}

const PROBE_IMAGE = 'busybox:1.36.1'

async function docker(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  const r = await execa('docker', args, { reject: false, stdin: 'ignore', timeout: 60_000 })
  return { ok: r.exitCode === 0, stdout: typeof r.stdout === 'string' ? r.stdout : '' }
}

/**
 * Asks Docker itself. An `oom` event is what the daemon emits when a process in a container's
 * memory group is killed for memory, including test workers started by `exec`; `OOMKilled` is
 * set when a container's main process was. These are host-side `docker` calls with fixed
 * arguments; they read nothing from a checkout.
 */
export const dockerProbe: DockerProbe = {
  async outOfMemorySince(project, sinceMs) {
    const label = `label=com.docker.compose.project=${project}`
    const since = String(Math.floor(sinceMs / 1000) - 1)
    const until = String(Math.ceil(Date.now() / 1000) + 1)
    const events = await docker(['events', '--since', since, '--until', until, '--filter', 'type=container', '--filter', 'event=oom', '--filter', label, '--format', '{{.Action}}'])
    if (events.ok && events.stdout.split('\n').some((l) => l.trim() === 'oom')) return true
    const ids = await docker(['ps', '-aq', '--filter', label])
    if (!ids.ok || ids.stdout.trim() === '') return false
    const inspect = await docker(['inspect', '--format', '{{.State.OOMKilled}}', ...ids.stdout.trim().split('\n')])
    return inspect.ok && inspect.stdout.split('\n').some((l) => l.trim() === 'true')
  },
}

/**
 * Free space on the disk where Docker keeps images and containers, measured from inside a
 * tiny container, which works for Docker Desktop's virtual disk as well as a local daemon.
 * The first call may pull a small image.
 */
export const dockerDisk: DiskProbe = {
  async freeBytes() {
    const r = await docker(['run', '--rm', '--network', 'none', '--pull', 'missing', PROBE_IMAGE, 'df', '-Pk', '/'])
    if (!r.ok) return null
    const line = r.stdout.trim().split('\n').at(-1) ?? ''
    const available = Number(line.split(/\s+/)[3])
    return Number.isFinite(available) ? available * 1024 : null
  },
}
