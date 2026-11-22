import { readFileSync, unlinkSync } from 'node:fs'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import path from 'node:path'

// One docker environment at a time on a machine. Environments compete for the same memory and
// disk, and two test suites running at once made Docker's out-of-memory killer fail a correct
// fix. A lock file, created exclusively, holds the pid of the process that owns it. It is
// removed on release and when the process exits; a lock whose process is gone (a crash, a kill)
// is taken over. This module imports only node: modules.

interface Holder { pid: number; host: string; at: string; token?: string }

function alive(pid: number): boolean {
  // Only a real process id is checked; anything else counts as alive, so it is never taken over.
  if (!Number.isInteger(pid) || pid <= 0) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Locks this process holds, by file and token, released at exit even when the code that took them did not get to. */
const held = new Map<string, string>()
let exitHook = false

function releaseAtExit(): void {
  for (const [file, token] of held) {
    try {
      const h = JSON.parse(readFileSync(file, 'utf8')) as Holder
      if (h.token === token) unlinkSync(file)
    } catch {
      // Already gone.
    }
  }
}

export class HostLock {
  private readonly file: string
  private readonly pollMs: number
  private readonly isAlive: (pid: number) => boolean
  /** Tells this holder's lock apart from another holder's in the same process. */
  private readonly token = randomUUID()

  constructor(o: { file: string; pollMs?: number; isAlive?: (pid: number) => boolean }) {
    this.file = o.file
    this.pollMs = o.pollMs ?? 2000
    this.isAlive = o.isAlive ?? alive
  }

  /** Waits up to `timeoutMs` for the lock; throws once that time is spent. */
  async acquire(timeoutMs: number): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const giveUp = Date.now() + timeoutMs
    for (;;) {
      const owner = await this.tryTake()
      if (owner === null) return
      if (!this.isAlive(owner.pid) && owner.host === hostname()) {
        // The process that held it is gone. Remove its lock, unless another waiter just did.
        await unlink(this.file).catch(() => undefined)
        continue
      }
      if (Date.now() >= giveUp) {
        throw new Error(`Another Rumba process (pid ${owner.pid}) is running a docker environment on this machine since ${owner.at}, and it did not finish in time. Only one runs at a time; see ${this.file}.`)
      }
      await new Promise((r) => setTimeout(r, Math.min(this.pollMs, Math.max(1, giveUp - Date.now()))))
    }
  }

  /** Removes the lock if this holder holds it. */
  async release(): Promise<void> {
    if (held.get(this.file) === this.token) held.delete(this.file)
    const owner = await this.read()
    if (owner?.token === this.token) await unlink(this.file).catch(() => undefined)
  }

  /** Null when this process now holds the lock; otherwise who holds it. */
  private async tryTake(): Promise<Holder | null> {
    try {
      const handle = await open(this.file, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: this.token } satisfies Holder))
      } finally {
        await handle.close()
      }
      held.set(this.file, this.token)
      if (!exitHook) {
        exitHook = true
        process.on('exit', releaseAtExit)
      }
      return null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // A lock being written right now reads as empty; treat it as held by an unknown live process.
      return (await this.read()) ?? { pid: -1, host: hostname(), at: 'just now' }
    }
  }

  private async read(): Promise<Holder | null> {
    try {
      const h = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Holder>
      return typeof h.pid === 'number' ? { pid: h.pid, host: h.host ?? hostname(), at: h.at ?? 'unknown', ...(h.token ? { token: h.token } : {}) } : null
    } catch {
      return null
    }
  }
}
