import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DockerEnvironment, shellRunner } from '../../../src/adapters/environment/docker.js'

const cfg = { up: 'docker compose up -d --wait', exec: 'docker compose exec -T app', down: 'docker compose down -v' }
const ref = { branch: 'b', sha: 's', role: 'before' as const }

type Call = { c: string; cwd: string; timeoutMs: number; env?: Record<string, string> }

/** Hands out the directories `/t1`, `/t2`, … and records, in order, everything it was asked to do. */
function trustedStub(o: { changedFrom?: number; restoreFails?: boolean } = {}) {
  const asked: string[] = []
  const removed: string[] = []
  const log: string[] = []
  let verifications = 0
  return {
    asked, removed, log,
    trustedCheckout: async (branch: string) => { asked.push(branch); return `/t${asked.length}` },
    verifyTrusted: async (dir: string) => {
      verifications += 1
      log.push(`verify ${dir}`)
      if (o.changedFrom !== undefined && verifications >= o.changedFrom) throw new Error(`The trusted checkout ${dir} no longer matches its commit: compose.yml`)
    },
    restoreTrusted: async (dir: string) => {
      log.push(`restore ${dir}`)
      if (o.restoreFails) throw new Error('cannot restore')
      verifications = -1000
    },
    cleanup: async (dir: string) => { removed.push(dir); log.push(`cleanup ${dir}`) },
  }
}

describe('DockerEnvironment', () => {
  it('runs up and a check in the trusted checkout, with the commit under test in RUMBA_WORKDIR', async () => {
    const calls: Call[] = []
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c, o) => { calls.push({ c, ...o }); return { exitCode: 0, output: 'ok' } } })
    const h = await env.up(ref, '/w')
    const r = await env.runCheck(h, { criterionId: 'c1', command: "npm test -- -t 'saves profile'", files: [] })
    expect(h).toEqual({ workdir: '/w', hostDir: '/t1' })
    expect(trusted.asked).toEqual(['b'])
    expect(calls.map((x) => `${x.cwd}: ${x.c}`)).toEqual([
      '/t1: docker compose up -d --wait',
      `/t1: docker compose exec -T app sh -c 'npm test -- -t '\\''saves profile'\\'''`,
    ])
    for (const x of calls) expect(x.env).toEqual({ RUMBA_WORKDIR: '/w' })
    expect(r).toEqual({ criterionId: 'c1', passed: true, exitCode: 0, output: 'ok' })
  })
  it('never runs a command in the directory of the commit under test', async () => {
    const cwds: string[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), run: async (_c, o) => { cwds.push(o.cwd); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })
    await env.runCommand(h, 'npm test')
    await env.down(h)
    expect(cwds).toEqual(['/t1', '/t1', '/t1', '/t1'])
  })
  it('reports a failing check without throwing', async () => {
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), run: async c => c.includes('exec') ? { exitCode: 1, output: 'AssertionError' } : { exitCode: 0, output: '' } })
    const h = await env.up(ref, '/w')
    expect(await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })).toMatchObject({ passed: false, exitCode: 1, output: 'AssertionError' })
  })
  it('throws with the output when up fails, after running down and removing the trusted checkout', async () => {
    const calls: string[] = []
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c, o) => { calls.push(`${o.cwd}: ${c}`); return { exitCode: 1, output: 'port in use' } } })
    await expect(env.up(ref, '/w')).rejects.toThrow(/port in use/)
    expect(calls).toEqual([`/t1: ${cfg.up}`, `/t1: ${cfg.down}`])
    expect(trusted.removed).toEqual(['/t1'])
  })
  it('removes the trusted checkout when the up command cannot be run at all', async () => {
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async () => { throw new Error('boom') } })
    await expect(env.up(ref, '/w')).rejects.toThrow('boom')
    expect(trusted.removed).toEqual(['/t1'])
  })
  it('runs nothing when no trusted checkout can be made', async () => {
    const calls: string[] = []
    const trusted = { ...trustedStub(), trustedCheckout: async () => { throw new Error('no base') } }
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    await expect(env.up(ref, '/w')).rejects.toThrow('no base')
    expect(calls).toEqual([])
  })
  it('takes the environment down in the trusted checkout, then removes it', async () => {
    const calls: Call[] = []
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c, o) => { calls.push({ c, ...o }); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await env.down(h)
    expect(calls.at(-1)).toMatchObject({ c: cfg.down, cwd: '/t1', env: { RUMBA_WORKDIR: '/w' } })
    expect(trusted.removed).toEqual(['/t1'])
  })
  it('never throws from down, even when the runner and the cleanup reject, and still removes the checkout', async () => {
    const removed: string[] = []
    const trusted = { ...trustedStub(), trustedCheckout: async () => '/t1', cleanup: async (d: string) => { removed.push(d); throw new Error('busy') } }
    let fail = false
    const env = new DockerEnvironment({ ...cfg, trusted, run: async () => { if (fail) throw new Error('boom'); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    fail = true
    await expect(env.down(h)).resolves.toBeUndefined()
    expect(removed).toEqual(['/t1'])
  })
  it('checks the trusted checkout against its commit before every host command', async () => {
    const trusted = trustedStub()
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { trusted.log.push(`run ${c.split(' ').slice(0, 3).join(' ')}`); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })
    await env.runCommand(h, 'npm test')
    await env.down(h)
    expect(trusted.log).toEqual([
      'verify /t1', 'run docker compose up',
      'verify /t1', 'run docker compose exec',
      'verify /t1', 'run docker compose exec',
      'verify /t1', 'run docker compose down',
      'cleanup /t1',
    ])
  })
  it('runs no check once the trusted checkout has changed, and says why', async () => {
    const calls: string[] = []
    const trusted = trustedStub({ changedFrom: 2 })
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await expect(env.runCheck(h, { criterionId: 'c1', command: 'x', files: [] })).rejects.toThrow(/no longer matches its commit: compose\.yml/)
    await expect(env.runCommand(h, 'npm test')).rejects.toThrow(/no longer matches/)
    expect(calls).toEqual([cfg.up])
  })
  it('takes a changed environment down from a restored checkout, never from the changed one', async () => {
    const trusted = trustedStub({ changedFrom: 2 })
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { trusted.log.push(`run ${c.split(' ').slice(0, 3).join(' ')}`); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await env.down(h)
    expect(trusted.log).toEqual(['verify /t1', 'run docker compose up', 'verify /t1', 'restore /t1', 'verify /t1', 'run docker compose down', 'cleanup /t1'])
  })
  it('runs no down command when a changed checkout cannot be restored, and still removes it', async () => {
    const calls: string[] = []
    const trusted = trustedStub({ changedFrom: 2, restoreFails: true })
    const env = new DockerEnvironment({ ...cfg, trusted, run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    const h = await env.up(ref, '/w')
    await expect(env.down(h)).resolves.toBeUndefined()
    expect(calls).toEqual([cfg.up])
    expect(trusted.removed).toEqual(['/t1'])
  })
  it('refuses a handle it did not bring up, and runs nothing for it', async () => {
    const calls: string[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), run: async (c) => { calls.push(c); return { exitCode: 0, output: '' } } })
    await expect(env.runCommand({ workdir: '/w' }, 'ls')).rejects.toThrow(/trusted checkout/)
    await expect(env.down({ workdir: '/w' })).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })
  it('runs an arbitrary command through the exec prefix and passes the timeout', async () => {
    const seen: Call[] = []
    const env = new DockerEnvironment({ ...cfg, trusted: trustedStub(), timeoutMs: 5, run: async (c, o) => { seen.push({ c, ...o }); return { exitCode: 2, output: 'x' } } })
    expect(await env.runCommand({ workdir: '/w', hostDir: '/t' }, 'ls')).toEqual({ exitCode: 2, output: 'x' })
    expect(seen).toEqual([{ c: "docker compose exec -T app sh -c 'ls'", cwd: '/t', timeoutMs: 5, env: { RUMBA_WORKDIR: '/w' } }])
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
