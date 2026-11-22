import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostLock } from '../../src/adapters/environment/hostLock.js'

// One docker environment at a time on a machine: two Rumba processes never run environments
// side by side, because the second waits for the first's lock.

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'rumba-lock-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('HostLock', () => {
  it('lets one holder in at a time; the second gets it once the first releases', async () => {
    const file = path.join(dir, 'environment.lock')
    const a = new HostLock({ file, pollMs: 10 }); const b = new HostLock({ file, pollMs: 10 })
    await a.acquire(1000)
    let bHas = false
    const waiting = b.acquire(2000).then(() => { bHas = true })
    await new Promise((r) => setTimeout(r, 100))
    expect(bHas).toBe(false)
    await a.release()
    await waiting
    expect(bHas).toBe(true)
    await b.release()
    expect(existsSync(file)).toBe(false)
  })
  it('gives up with a clear error after the time it may wait', async () => {
    const file = path.join(dir, 'environment.lock')
    const a = new HostLock({ file, pollMs: 10 }); await a.acquire(1000)
    await expect(new HostLock({ file, pollMs: 10 }).acquire(100)).rejects.toThrow(/Another Rumba process \(pid \d+\) is running a docker environment on this machine/)
    await a.release()
  })
  it('takes over a lock whose process is gone, as after a crash', async () => {
    const file = path.join(dir, 'environment.lock')
    const child = await execa(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'])
    await writeFile(file, JSON.stringify({ pid: Number(child.stdout), at: new Date().toISOString() }))
    const b = new HostLock({ file, pollMs: 10 })
    await b.acquire(500)
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid)
    await b.release()
  })
  it('is released when the process that holds it exits', async () => {
    const file = path.join(dir, 'environment.lock')
    const src = path.resolve('src/adapters/environment/hostLock.ts')
    // Node strips the types of the .ts module; the lock module imports only node: modules.
    const r = await execa(process.execPath, ['--input-type=module', '-e', `const { HostLock } = await import(${JSON.stringify(src)}); await new HostLock({ file: ${JSON.stringify(file)} }).acquire(1000); console.log('held')`], { reject: false })
    expect(r.stdout).toContain('held')
    expect(existsSync(file)).toBe(false)
  })
  it('never removes a lock another process holds', async () => {
    const file = path.join(dir, 'environment.lock')
    const a = new HostLock({ file, pollMs: 10 }); await a.acquire(1000)
    await new HostLock({ file }).release()
    expect(existsSync(file)).toBe(true)
    await a.release()
  })
})
