import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DockerEnvironment, shellRunner } from '../../../src/adapters/environment/docker.js'

const cfg = { up: 'docker compose up -d --wait', exec: 'docker compose exec -T app', down: 'docker compose down -v' }
const ref = { branch: 'b', sha: 's', role: 'before' as const }

type Call = { c: string; cwd: string; timeoutMs: number; env?: Record<string, string> }

/**
 * Hands out the directories `/t1`, `/t2`, … and records, in order, everything it was asked
 * to do. `changed` names directories whose verification fails; `failFrom` makes the n-th and
 * later checkouts impossible.
 */
function trustedStub(o: { changed?: string[]; failFrom?: number } = {}) {
  const asked: string[] = []
  const removed: string[] = []
  const log: string[] = []
  return {
    asked, removed, log,
    trustedCheckout: async (branch: string) => {
      if (o.failFrom !== undefined && asked.length + 1 >= o.failFrom) throw new Error('no checkout')
      asked.push(branch)
      log.push(`checkout /t${asked.length}`)
      return `/t${asked.length}`
    },
    verifyTrusted: async (dir: string) => {
      log.push(`verify ${dir}`)
      if (o.changed?.includes(dir)) throw new Error(`The trusted checkout ${dir} no longer matches its commit: compose.yml`)
    },
    cleanup: async (dir: string) => { removed.push(dir); log.push(`cleanup ${dir}`) },
  }
}

/** A runner that records each command in the stub's log as `run <dir>: <first three words>`. */
const logging = (trusted: { log: string[] }, exitCode = 0) => async (c: string, o: { cwd: string }) => {
  trusted.log.push(`run ${o.cwd}: ${c.split(' ').slice(0, 3).join(' ')}`)
  return { exitCode, output: exitCode === 0 ? 'ok' : 'port in use' }
}

describe('DockerEnvironment', () => {
  it('runs up in a trusted checkout, with the commit under test in RUMBA_WORKDIR and a project name of its own', async () => {
    const calls: Call[] = []
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c, o) => { calls.push({ c, ...o }); return { exitCode: 0, output: 'ok' } } })
    const h = await env.up(ref, '/w')
    expect(trusted.asked).toEqual(['b'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ c: 'docker compose up -d --wait', cwd: '/t1' })
    expect(calls[0].env).toEqual({ RUMBA_WORKDIR: '/w', COMPOSE_PROJECT_NAME: expect.stringMatching(/^rumba-[a-z0-9]{12,}$/) })
    expect(h).toEqual({ workdir: '/w', host: { branch: 'b', project: calls[0].env!.COMPOSE_PROJECT_NAME, upDir: '/t1' } })
    const other = await env.up(ref, '/w2')
    expect(other.host!.project).not.toBe(h.host!.project)
  })
  it('runs every later command in a checkout made for it, which no container existed to be given', async () => {
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: logging(trusted) })
    const h = await env.up(ref, '/w')
    await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })
    await env.runCommand(h, 'npm test')
    await env.down(h)
    expect(trusted.log).toEqual([
      'checkout /t1', 'run /t1: docker compose up', 'verify /t1',
      'checkout /t2', 'run /t2: docker compose exec', 'cleanup /t2',
      'checkout /t3', 'run /t3: docker compose exec', 'cleanup /t3',
      'checkout /t4', 'run /t4: docker compose down', 'cleanup /t4',
      'cleanup /t1',
    ])
    expect(trusted.asked).toEqual(['b', 'b', 'b', 'b'])
  })
  it('gives every command of one environment the same project name and the commit under test', async () => {
    const calls: Call[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), run: async (c, o) => { calls.push({ c, ...o }); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })
    await env.down(h)
    expect(calls.map((x) => x.cwd)).toEqual(['/t1', '/t2', '/t3'])
    for (const x of calls) expect(x.env).toEqual({ RUMBA_WORKDIR: '/w', COMPOSE_PROJECT_NAME: h.host!.project })
  })
  it('passes a check through the exec prefix, quoted, and reports its result', async () => {
    const calls: string[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), run: async (c) => { calls.push(c); return { exitCode: 0, output: 'ok' } } })
    const h = await env.up(ref, '/w')
    const r = await env.runCheck(h, { criterionId: 'c1', command: "npm test -- -t 'saves profile'", files: [] })
    expect(calls[1]).toBe(`docker compose exec -T app sh -c 'npm test -- -t '\\''saves profile'\\'''`)
    expect(r).toEqual({ criterionId: 'c1', passed: true, exitCode: 0, output: 'ok' })
  })
  it('reports a failing check without throwing, and still removes its checkout', async () => {
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async c => c.includes('exec') ? { exitCode: 1, output: 'AssertionError' } : { exitCode: 0, output: '' } })
    const h = await env.up(ref, '/w')
    expect(await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })).toMatchObject({ passed: false, exitCode: 1, output: 'AssertionError' })
    expect(trusted.removed).toEqual(['/t2'])
  })
  it('removes the checkout of a check whose command could not be run at all', async () => {
    const trusted = trustedStub()
    let fail = false
    const env = new DockerEnvironment({ ...cfg, trusted, run: async () => { if (fail) throw new Error('boom'); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    fail = true
    await expect(env.runCommand(h, 'x')).rejects.toThrow('boom')
    expect(trusted.removed).toEqual(['/t2'])
  })
  it('throws with the output when up fails, after taking the environment down from a new checkout', async () => {
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: logging(trusted, 1) })
    await expect(env.up(ref, '/w')).rejects.toThrow(/port in use/)
    expect(trusted.log).toEqual(['checkout /t1', 'run /t1: docker compose up', 'verify /t1', 'checkout /t2', 'run /t2: docker compose down', 'cleanup /t2', 'cleanup /t1'])
  })
  it('stops when the folder up ran in was changed while it ran, even if up succeeded', async () => {
    const trusted = trustedStub({ changed: ['/t1'] })
    const env = new DockerEnvironment({ ...cfg, trusted, run: logging(trusted) })
    await expect(env.up(ref, '/w')).rejects.toThrow(/no longer matches its commit: compose\.yml/)
    expect(trusted.log).toEqual(['checkout /t1', 'run /t1: docker compose up', 'verify /t1', 'checkout /t2', 'run /t2: docker compose down', 'cleanup /t2', 'cleanup /t1'])
  })
  it('takes the environment down and removes the checkout when the up command cannot be run at all', async () => {
    const trusted = trustedStub()
    let first = true
    const env = new DockerEnvironment({ ...cfg, trusted, run: async () => { if (first) { first = false; throw new Error('boom') } return { exitCode: 0, output: '' } } })
    await expect(env.up(ref, '/w')).rejects.toThrow('boom')
    expect(trusted.removed).toEqual(['/t2', '/t1'])
  })
  it('runs nothing when no trusted checkout can be made', async () => {
    const calls: string[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub({ failFrom: 1 }), run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    await expect(env.up(ref, '/w')).rejects.toThrow('no checkout')
    expect(calls).toEqual([])
  })
  it('runs no check when no checkout can be made for it', async () => {
    const calls: string[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub({ failFrom: 2 }), run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await expect(env.runCommand(h, 'npm test')).rejects.toThrow('no checkout')
    expect(calls).toEqual([cfg.up])
  })
  it('never throws from down: with no checkout to run it in, it runs nothing and still removes the up folder', async () => {
    const calls: string[] = []
    const trusted = trustedStub({ failFrom: 2 })
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await expect(env.down(h)).resolves.toBeUndefined()
    expect(calls).toEqual([cfg.up])
    expect(trusted.removed).toEqual(['/t1'])
  })
  it('never throws from down, even when the runner and the cleanup reject', async () => {
    const removed: string[] = []
    const trusted = { ...trustedStub(), cleanup: async (d: string) => { removed.push(d); throw new Error('busy') } }
    let fail = false
    const env = new DockerEnvironment({ ...cfg, trusted, run: async () => { if (fail) throw new Error('boom'); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    fail = true
    await expect(env.down(h)).resolves.toBeUndefined()
    expect(removed).toEqual(['/t2', '/t1'])
  })
  it('refuses a handle it did not bring up, and runs nothing for it', async () => {
    const calls: string[] = []
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    await expect(env.runCommand({ workdir: '/w' }, 'ls')).rejects.toThrow(/not brought up/)
    await expect(env.down({ workdir: '/w' })).resolves.toBeUndefined()
    expect(calls).toEqual([])
    expect(trusted.asked).toEqual([])
  })
  it('passes the timeout to every command', async () => {
    const seen: number[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), timeoutMs: 5, run: async (_c, o) => { seen.push(o.timeoutMs); return { exitCode: 2, output: 'x' } } })
    expect(await env.runCommand({ workdir: '/w', host: { branch: 'b', project: 'rumba-x', upDir: '/t0' } }, 'ls')).toEqual({ exitCode: 2, output: 'x' })
    expect(seen).toEqual([5])
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
  it('adds the variables it is given, over the inherited ones', async () => {
    process.env.RUMBA_WORKDIR = '/inherited'
    try {
      const r = await shellRunner('printf "%s" "$RUMBA_WORKDIR"', { cwd: process.cwd(), timeoutMs: 5000, env: { RUMBA_WORKDIR: '/given' } })
      expect(r).toEqual({ exitCode: 0, output: '/given' })
    } finally {
      delete process.env.RUMBA_WORKDIR
    }
  })
  it('sets PWD to the directory the command runs in', async () => {
    const dir = await realpath(tmpdir())
    expect(await shellRunner('printf "%s" "$PWD"; printf " %s" "$(env | grep -c "^PWD=")"', { cwd: dir, timeoutMs: 5000 })).toEqual({ exitCode: 0, output: `${dir} 1` })
  })
  it('reports exit code 124 on timeout', async () => {
    expect((await shellRunner('sleep 5', { cwd: process.cwd(), timeoutMs: 200 })).exitCode).toBe(124)
  })
})
