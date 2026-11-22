import { readFileSync, unlinkSync } from 'node:fs'
import { link, mkdir, open, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
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
  /** For tests: runs between judging a lock stale and removing it. */
  private readonly beforeRemoveStale: () => Promise<void>
  /** Tells this holder's lock apart from another holder's in the same process. */
  private readonly token = randomUUID()

  constructor(o: { file: string; pollMs?: number; isAlive?: (pid: number) => boolean; beforeRemoveStale?: () => Promise<void> }) {
    this.file = o.file
    this.pollMs = o.pollMs ?? 2000
    this.isAlive = o.isAlive ?? alive
    this.beforeRemoveStale = o.beforeRemoveStale ?? (async () => {})
  }

  /** Waits up to `timeoutMs` for the lock; throws once that time is spent. */
  async acquire(timeoutMs: number): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    await this.removeDeadDrafts()
    const giveUp = Date.now() + timeoutMs
    for (;;) {
      const judged = await stat(this.file).catch(() => null)
      const judgedText = await readFile(this.file, 'utf8').catch(() => null)
      const owner = await this.tryTake()
      if (owner === null) return
      if (owner === 'unreadable' ? await this.oldUnreadable() : !this.isAlive(owner.pid)) {
        // The process that held it is gone, or its lock was never written whole. Remove it, but
        // only if it is still the file that was judged: another waiter may have replaced it.
        await this.beforeRemoveStale()
        // Same inode, same modification time and same content: an inode number can be reused
        // for a new lock at once, so the number alone is not enough.
        const now = await stat(this.file).catch(() => null)
        const nowText = await readFile(this.file, 'utf8').catch(() => null)
        const same = judged !== null && now !== null && now.ino === judged.ino && now.dev === judged.dev && now.mtimeMs === judged.mtimeMs && nowText === judgedText
        if (same) await unlink(this.file).catch(() => undefined)
        if (Date.now() < giveUp) continue
      }
      if (Date.now() >= giveUp) {
        const who = owner === 'unreadable' ? 'Another Rumba process' : `Another Rumba process (pid ${owner.pid})`
        const since = owner === 'unreadable' ? '' : ` since ${owner.at}`
        throw new Error(`${who} is running a docker environment on this machine${since}, and it did not finish in time. Only one runs at a time; see ${this.file}.`)
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

  /**
   * Null when this holder now has the lock; otherwise who holds it. The lock is written whole
   * to a file of its own first and then linked into place, so it is never seen half written.
   */
  private async tryTake(): Promise<Holder | 'unreadable' | null> {
    const draft = `${this.file}.${process.pid}.${this.token}`
    const content = JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: this.token } satisfies Holder)
    await writeFile(draft, content, { mode: 0o600 })
    try {
      try {
        await link(draft, this.file)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw e
        // A file system without hard links: create the lock exclusively and write it in place.
        const handle = await open(this.file, 'wx', 0o600)
        try {
          await handle.writeFile(content)
        } finally {
          await handle.close()
        }
      }
      held.set(this.file, this.token)
      if (!exitHook) {
        exitHook = true
        process.on('exit', releaseAtExit)
      }
      return null
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      return (await this.read()) ?? 'unreadable'
    } finally {
      await unlink(draft).catch(() => undefined)
    }
  }

  /** Removes draft lock files (`<lock>.<pid>.<token>`) of processes that are gone. */
  private async removeDeadDrafts(): Promise<void> {
    const prefix = `${path.basename(this.file)}.`
    for (const name of await readdir(path.dirname(this.file)).catch(() => [] as string[])) {
      if (!name.startsWith(prefix)) continue
      const pid = Number(name.slice(prefix.length).split('.')[0])
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && !this.isAlive(pid)) await unlink(path.join(path.dirname(this.file), name)).catch(() => undefined)
    }
  }

  /** A lock file nobody can read (left empty by a crash, or written by something else) counts as stale once it is a few seconds old. */
  private async oldUnreadable(): Promise<boolean> {
    const s = await stat(this.file).catch(() => null)
    return s === null || Date.now() - s.mtimeMs > 10_000
  }

  private async read(): Promise<Holder | null> {
    try {
      const h = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Holder>
      return typeof h.pid === 'number' && Number.isInteger(h.pid) && h.pid > 0 ? { pid: h.pid, host: h.host ?? hostname(), at: h.at ?? 'unknown', ...(h.token ? { token: h.token } : {}) } : null
    } catch {
      return null
    }
  }
}
