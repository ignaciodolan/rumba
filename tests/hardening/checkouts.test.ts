import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEnvironment } from '../../src/adapters/environment/docker.js'
import { GitWorkspace } from '../../src/adapters/workspace/git.js'
import { InfrastructureError } from '../../src/ports/environment.js'

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, stdin: 'ignore' })).stdout.trim()
}

describe('checkouts are readable by a project image built as a non-root user', () => {
  let root: string; let clone: string; let ws: GitWorkspace; let saved: number
  beforeEach(async () => {
    saved = process.umask(0o077)
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-umask-')))
    const remote = path.join(root, 'remote.git'); await mkdir(remote); await git(remote, 'init', '-q', '--bare')
    await git(root, 'clone', '-q', remote, 'clone'); clone = path.join(root, 'clone')
    await mkdir(path.join(clone, 'src')); await writeFile(path.join(clone, 'src/a.js'), 'x')
    await git(clone, 'add', '-A'); await git(clone, 'commit', '-q', '-m', 'i'); await git(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); await git(clone, 'fetch', '-q')
    ws = new GitWorkspace({ repoRoot: clone, defaultBranch: 'main' })
  })
  afterEach(async () => { process.umask(saved); await ws.cleanupAll(); await rm(root, { recursive: true, force: true }) })

  it('creates the files with mode 644 and folders with 755 under a caller umask of 077, and keeps the parent private', async () => {
    const { workdir } = await ws.prepare('rumba/shop/1', { fresh: true })
    expect((await stat(path.join(workdir, 'src/a.js'))).mode & 0o777).toBe(0o644)
    expect((await stat(path.join(workdir, 'src'))).mode & 0o777).toBe(0o755)
    expect((await stat(path.dirname(workdir))).mode & 0o777).toBe(0o700)
    const trusted = await ws.trustedCheckout('rumba/shop/1')
    expect((await stat(path.join(trusted, 'src/a.js'))).mode & 0o777).toBe(0o644)
  })
})

describe('free disk space for Docker', () => {
  const trusted = { trustedCheckout: async () => '/t', verifyTrusted: async () => {}, cleanup: async () => {} }
  const noLock = { acquire: async () => {}, release: async () => {} }
  const docker = { outOfMemorySince: async () => false }

  it('fails with a clear "not enough disk" error before running up', async () => {
    const ran: string[] = []
    const env = new DockerEnvironment({
      up: 'up', exec: 'exec', down: 'down', trusted, lock: noLock, docker, minFreeBytes: 5 * 2 ** 30,
      disk: { freeBytes: async () => 1.2 * 2 ** 30 }, run: async (c) => { ran.push(c); return { exitCode: 0, output: '' } },
    })
    const err = await env.up({ branch: 'b', sha: 's', role: 'base' }, '/w').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfrastructureError)
    expect((err as Error).message).toBe('Not enough disk space for Docker: 1.2 GB free, at least 5.0 GB needed. Free some with `docker system prune`, or give Docker a larger disk.')
    expect(ran).toEqual([])
  })
  it('goes ahead when it cannot tell how much space is free', async () => {
    const ran: string[] = []
    const env = new DockerEnvironment({
      up: 'up', exec: 'exec', down: 'down', trusted, lock: noLock, docker, minFreeBytes: 5 * 2 ** 30,
      disk: { freeBytes: async () => null }, run: async (c) => { ran.push(c); return { exitCode: 0, output: '' } },
    })
    await env.up({ branch: 'b', sha: 's', role: 'base' }, '/w')
    expect(ran).toEqual(['up'])
  })
})

describe('one environment at a time', () => {
  it('holds the lock from before up until after down, and releases it when up fails', async () => {
    const log: string[] = []
    const lock = { acquire: async (ms: number) => { log.push(`acquire ${ms > 0}`) }, release: async () => { log.push('release') } }
    const trusted = { trustedCheckout: async () => '/t', verifyTrusted: async () => {}, cleanup: async () => {} }
    let upExit = 0
    const env = new DockerEnvironment({
      up: 'up', exec: 'exec', down: 'down', trusted, lock, docker: { outOfMemorySince: async () => false }, disk: { freeBytes: async () => null },
      run: async (c) => { log.push(c); return { exitCode: c === 'up' ? upExit : 0, output: '' } },
    })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after', timeoutMs: 60_000 }, '/w')
    await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })
    await env.down(h)
    expect(log).toEqual(['acquire true', 'up', "exec sh -c 'x'", 'down', 'release'])
    log.length = 0; upExit = 1
    await expect(env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')).rejects.toThrow()
    expect(log).toEqual(['acquire true', 'up', 'down', 'release'])
  })
})
