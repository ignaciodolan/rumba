import { describe, expect, it } from 'vitest'
import { DockerEnvironment } from '../../src/adapters/environment/docker.js'
import { classifyInfrastructure } from '../../src/adapters/environment/infrastructure.js'
import { InfrastructureError } from '../../src/ports/environment.js'

// A check or the project tests can die of the machine, not of the change: the out-of-memory
// killer, a full disk, a timeout. Rumba must tell those apart from a real failure, using what
// Docker reports where it can.

describe('classifyInfrastructure', () => {
  it.each([
    [137, 'Error: test failed', false, /exit 137.*out-of-memory killer/],
    [1, 'Error: ENOSPC: no space left on device, write', false, /disk/],
    [1, 'Error: Worker exited unexpectedly\n  ❯ tinypool', false, /test workers were killed/],
    [1, 'Tests: 3 failed\nKilled', false, /killed/],
    [124, '', false, /timed out/],
    [1, 'AssertionError: expected 1 to be 2', true, /Docker reported that a container ran out of memory/],
  ])('calls exit %i with this output infrastructure', (code, output, dockerOom, reason) => {
    expect(classifyInfrastructure({ exitCode: code, output, dockerOom })).toMatch(reason)
  })
  it.each([
    [1, 'AssertionError: expected "Hello-World" to be "hello-world"'],
    [2, 'FAIL test/slug.test.js'],
    [127, 'sh: pnpm: not found'],
  ])('leaves an ordinary failure alone (exit %i)', (code, output) => {
    expect(classifyInfrastructure({ exitCode: code, output, dockerOom: false })).toBeUndefined()
  })
})

describe('DockerEnvironment and infrastructure', () => {
  const cfg = { up: 'up', exec: 'exec', down: 'down' }
  const trusted = { trustedCheckout: async () => '/t', verifyTrusted: async () => {}, cleanup: async () => {} }
  const noLock = { acquire: async () => {}, release: async () => {} }
  const plenty = { freeBytes: async () => 100 * 2 ** 30 }

  it('asks Docker whether the project ran out of memory after a failed check, and says so', async () => {
    const asked: string[] = []
    const env = new DockerEnvironment({
      ...cfg, trusted, lock: noLock, disk: plenty,
      run: async (c) => (c.startsWith('exec') ? { exitCode: 1, output: 'Error: something broke' } : { exitCode: 0, output: '' }),
      docker: { outOfMemorySince: async (project) => { asked.push(project); return true } },
    })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')
    const r = await env.runCheck(h, { criterionId: 'c1', command: 'npm test', files: [] })
    expect(asked).toEqual([h.host!.project])
    expect(r).toMatchObject({ passed: false, exitCode: 1 })
    expect(r.infrastructure).toMatch(/Docker reported that a container ran out of memory/)
  })
  it('marks the project tests killed with exit 137 as infrastructure', async () => {
    const env = new DockerEnvironment({
      ...cfg, trusted, lock: noLock, disk: plenty,
      run: async (c) => (c.startsWith('exec') ? { exitCode: 137, output: '' } : { exitCode: 0, output: '' }),
      docker: { outOfMemorySince: async () => false },
    })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')
    expect((await env.runCommand(h, 'pnpm test')).infrastructure).toMatch(/exit 137/)
  })
  it('leaves a passing check alone without asking Docker', async () => {
    let asked = 0
    const env = new DockerEnvironment({ ...cfg, trusted, lock: noLock, disk: plenty, run: async () => ({ exitCode: 0, output: 'ok' }), docker: { outOfMemorySince: async () => { asked++; return true } } })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')
    expect((await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })).infrastructure).toBeUndefined()
    expect(asked).toBe(0)
  })
  it('throws InfrastructureError when up fails because the disk is full', async () => {
    const env = new DockerEnvironment({
      ...cfg, trusted, lock: noLock, disk: plenty,
      run: async (c) => (c === 'up' ? { exitCode: 1, output: 'failed to copy files: write /var/lib/docker/x: no space left on device' } : { exitCode: 0, output: '' }),
      docker: { outOfMemorySince: async () => false },
    })
    const err = await env.up({ branch: 'b', sha: 's', role: 'base' }, '/w').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfrastructureError)
    expect((err as Error).message).toMatch(/disk/)
  })
})
