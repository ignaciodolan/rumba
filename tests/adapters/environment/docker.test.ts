import { afterEach, describe, expect, it } from 'vitest'
import { DockerEnvironment, shellRunner } from '../../../src/adapters/environment/docker.js'

const cfg = { up: 'docker compose up -d --wait', exec: 'docker compose exec -T app', down: 'docker compose down -v' }
const ref = { branch: 'b', sha: 's', role: 'before' as const }

describe('DockerEnvironment', () => {
  it('runs up in the workdir and a check through the exec prefix', async () => {
    const calls: string[] = []
    const env = new DockerEnvironment({ ...cfg, run: async (c, o) => { calls.push(`${o.cwd}: ${c}`); return { exitCode: 0, output: 'ok' } } })
    const h = await env.up(ref, '/w')
    const r = await env.runCheck(h, { criterionId: 'c1', command: "npm test -- -t 'saves profile'", files: [] })
    expect(h).toEqual({ workdir: '/w' })
    expect(calls[0]).toBe('/w: docker compose up -d --wait')
    expect(calls[1]).toBe(`/w: docker compose exec -T app sh -c 'npm test -- -t '\\''saves profile'\\'''`)
    expect(r).toEqual({ criterionId: 'c1', passed: true, exitCode: 0, output: 'ok' })
  })
  it('reports a failing check without throwing', async () => {
    const env = new DockerEnvironment({ ...cfg, run: async c => c.includes('exec') ? { exitCode: 1, output: 'AssertionError' } : { exitCode: 0, output: '' } })
    const h = await env.up(ref, '/w')
    expect(await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })).toMatchObject({ passed: false, exitCode: 1, output: 'AssertionError' })
  })
  it('throws with the output when up fails, after running down, and swallows a failing down', async () => {
    const calls: string[] = []
    const env = new DockerEnvironment({ ...cfg, run: async c => { calls.push(c); return { exitCode: 1, output: 'port in use' } } })
    await expect(env.up(ref, '/w')).rejects.toThrow(/port in use/)
    expect(calls).toEqual([cfg.up, cfg.down])
    await expect(env.down({ workdir: '/w' })).resolves.toBeUndefined()
  })
  it('never throws from down, even when the runner rejects', async () => {
    const env = new DockerEnvironment({ ...cfg, run: async () => { throw new Error('boom') } })
    await expect(env.down({ workdir: '/w' })).resolves.toBeUndefined()
  })
  it('runs an arbitrary command through the exec prefix in the workdir and passes the timeout', async () => {
    const seen: { c: string; cwd: string; timeoutMs: number }[] = []
    const env = new DockerEnvironment({ ...cfg, timeoutMs: 5, run: async (c, o) => { seen.push({ c, ...o }); return { exitCode: 2, output: 'x' } } })
    expect(await env.runCommand({ workdir: '/w' }, 'ls')).toEqual({ exitCode: 2, output: 'x' })
    expect(seen).toEqual([{ c: "docker compose exec -T app sh -c 'ls'", cwd: '/w', timeoutMs: 5 }])
  })
})

const RUMBA_KEYS = [
  'RUMBA_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'LINEAR_API_KEY',
  'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'VERCEL_TOKEN', 'VERCEL_AUTOMATION_BYPASS_SECRET',
]

describe('shellRunner', () => {
  const secret = 'RUMBA_TEST_SECRET_VALUE'
  const saved = Object.fromEntries(RUMBA_KEYS.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('captures output and exit code', async () => {
    expect(await shellRunner('echo ok', { cwd: process.cwd(), timeoutMs: 5000 })).toEqual({ exitCode: 0, output: 'ok' })
    expect((await shellRunner('exit 3', { cwd: process.cwd(), timeoutMs: 5000 })).exitCode).toBe(3)
  })
  it('captures stderr together with stdout', async () => {
    const r = await shellRunner('echo out; echo err 1>&2', { cwd: process.cwd(), timeoutMs: 5000 })
    expect(r.output).toContain('out')
    expect(r.output).toContain('err')
  })
  it.each(RUMBA_KEYS)('keeps %s out of the command environment', async (key) => {
    process.env[key] = secret
    const r = await shellRunner(`printf "%s" "$${key}"`, { cwd: process.cwd(), timeoutMs: 5000 })
    expect(r).toEqual({ exitCode: 0, output: '' })
  })
  it('keeps the other variables', async () => {
    process.env.RUMBA_TEST_PLAIN = 'kept'
    try {
      expect(await shellRunner('printf "%s" "$RUMBA_TEST_PLAIN"', { cwd: process.cwd(), timeoutMs: 5000 })).toEqual({ exitCode: 0, output: 'kept' })
    } finally {
      delete process.env.RUMBA_TEST_PLAIN
    }
  })
  it('reports exit code 124 on timeout', async () => {
    expect((await shellRunner('sleep 5', { cwd: process.cwd(), timeoutMs: 200 })).exitCode).toBe(124)
  })
})
