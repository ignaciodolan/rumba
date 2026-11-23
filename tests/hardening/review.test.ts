import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEnvironment } from '../../src/adapters/environment/docker.js'
import { makeDockerProbe } from '../../src/adapters/environment/dockerProbe.js'
import { HostLock } from '../../src/adapters/environment/hostLock.js'
import { classifyInfrastructure } from '../../src/adapters/environment/infrastructure.js'
import { renderPullRequestBody } from '../../src/core/evidence.js'
import { runRumba } from '../../src/core/runner.js'
import { newState, transition } from '../../src/core/states.js'
import { build } from '../../src/core/steps/build.js'
import { openPullRequest } from '../../src/core/steps/openPullRequest.js'
import { InfrastructureError } from '../../src/ports/environment.js'
import { failing, makeDeps, makeRumba, makeTicket, scriptHappyBug, verified } from '../../src/testing/fakes.js'
import { buildDeps } from '../../src/wiring.js'

// Follow-ups from the independent review of the live-run hardening.

const H = { 'tests/rumba/c1.test.ts': 'h1' }
const fix = { kind: 'fix' as const, summary: 'fix' }
const withTests = makeRumba({ verify: { test: 'pnpm test' } })

describe('no change needed, with nothing ever committed', () => {
  it('never opens a pull request with no fix in it', async () => {
    const d = makeDeps(); d.workspace.hashes = H; d.environment.passes = () => true
    d.agent.script.fix = { kind: 'fix', summary: 'nothing to do', noChangeNeeded: 'the check passes already' }
    d.workspace.commitResults = [null]
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('needs_human')
    expect(d.tracker.comments.at(-1)!.body).toMatch(/no fix commit/)
    expect(d.environment.ups).toEqual([])
  })
})

describe('what the fix agent is told on a later run', () => {
  it('starts from the last attempt recorded on the ticket, not from the base run', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    const st = { ...failing(d), attempts: [{ n: 1, outcome: 'infrastructure' as const, checks: [{ criterionId: 'c1', passed: true, exitCode: 0 }], projectTests: 'infrastructure' as const, tail: 'Killed' }] }
    await build(d, withTests, makeTicket(), st)
    expect(d.agent.calls[0]).toMatchObject({ attempt: 2, checkStatus: [{ criterionId: 'c1', passed: true }], projectTests: 'infrastructure' })
  })
  it('goes back to the base run after a fix was rejected and reset', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    d.environment.commandResults = [{ exitCode: 1, output: 'FAIL' }, { exitCode: 1, output: 'FAIL' }]
    let calls = 0
    d.workspace.changedFiles = async () => (++calls === 2 ? ['.github/workflows/ci.yml'] : ['src/a.ts'])
    await build(d, makeRumba({ verify: { test: 'pnpm test' }, limits: { maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 3, maxReviewRounds: 2 } }), makeTicket(), failing(d))
    expect(d.agent.calls[1]).toMatchObject({ projectTests: 'failed' })
    expect(d.agent.calls[2]).toMatchObject({ checkStatus: [{ criterionId: 'c1', passed: false }], projectTests: 'not-run' })
  })
})

describe('attempt numbers and records', () => {
  it('keeps counting past the ten attempts kept', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    const old = Array.from({ length: 10 }, (_, i) => ({ n: i + 3, outcome: 'checks-failed' as const, checks: [], projectTests: 'not-run' as const, tail: '' }))
    const s = await build(d, makeRumba(), makeTicket(), { ...failing(d), attempts: old })
    expect(s.attempts).toHaveLength(10); expect(s.attempts!.at(-1)!.n).toBe(13)
  })
  it('starts the attempts again on rumba-retry', async () => {
    const d = makeDeps(); scriptHappyBug(d); const t = makeTicket({ id: '1', labels: ['rumba:shop', 'rumba-retry'] }); d.tracker.tickets.push(t)
    d.tracker.states.set('1', { ...transition(newState('shop', d.clock()), 'needs_human', d.clock()), attempts: [{ n: 1, outcome: 'guard', checks: [], projectTests: 'not-run', tail: '' }], fixSummary: 'old' })
    await runRumba(d, makeRumba())
    const s = d.tracker.states.get('1')!
    expect(s.attempts?.map((a) => a.n)).toEqual([1]); expect(s.attempts?.[0]?.outcome).toBe('verified')
  })
  it('says the last fix was rejected when that is why the attempts ran out', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.workspace.changed = ['.github/workflows/ci.yml']
    await build(d, makeRumba(), makeTicket(), failing(d))
    expect(d.tracker.comments.at(-1)!.body).toMatch(/^Rumba could not fix this after 2 attempts: the last fix was rejected\./)
  })
})

describe('the environment lock', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'rumba-lock2-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('counts the wait for the lock in the time the environment may use', async () => {
    const seen: number[] = []
    const lock = { acquire: async () => { await new Promise((r) => setTimeout(r, 1500)) }, release: async () => {} }
    const env = new DockerEnvironment({
      up: 'up', exec: 'exec', down: 'down', timeoutMs: 60_000, lock,
      trusted: { trustedCheckout: async () => '/t', verifyTrusted: async () => {}, cleanup: async () => {} },
      run: async (c, o) => { if (c !== 'down') seen.push(o.timeoutMs); return { exitCode: 0, output: '' } },
    })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after', timeoutMs: 2000 }, '/w')
    await env.runCommand(h, 'x')
    for (const t of seen) expect(t).toBeLessThanOrEqual(1000)
  })
  it('is an infrastructure error when the wait for the lock runs out', async () => {
    const file = path.join(dir, 'environment.lock')
    const a = new HostLock({ file, pollMs: 10 }); await a.acquire(1000)
    const env = new DockerEnvironment({
      up: 'up', exec: 'exec', down: 'down', lock: new HostLock({ file, pollMs: 10 }),
      trusted: { trustedCheckout: async () => '/t', verifyTrusted: async () => {}, cleanup: async () => {} },
      run: async () => ({ exitCode: 0, output: '' }),
    })
    const err = await env.up({ branch: 'b', sha: 's', role: 'after', timeoutMs: 50 }, '/w').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfrastructureError); expect((err as Error).message).toMatch(/Another Rumba process/)
    await a.release()
  })
  it('takes over a lock file left empty by a crash once it is a few seconds old', async () => {
    const file = path.join(dir, 'environment.lock')
    await writeFile(file, '')
    const old = new Date(Date.now() - 60_000); await utimes(file, old, old)
    await new HostLock({ file, pollMs: 10 }).acquire(500)
  })
  it('takes over a lock of a process that is gone, whatever host name it recorded', async () => {
    const file = path.join(dir, 'environment.lock')
    await writeFile(file, JSON.stringify({ pid: 999999, host: 'another-name.local', at: '2026-01-01T00:00:00Z' }))
    await new HostLock({ file, pollMs: 10, isAlive: () => false }).acquire(500)
  })
})

describe('telling the machine from the change', () => {
  it('asks Docker only for out-of-memory events, not the flag a container keeps once it was set', async () => {
    const calls: string[][] = []
    const probe = makeDockerProbe(async (args) => { calls.push(args); return { ok: true, stdout: args[0] === 'events' ? '' : 'true' } })
    expect(await probe.outOfMemorySince('rumba-x', Date.now() - 1000)).toBe(false)
    expect(calls.map((c) => c[0])).toEqual(['events'])
  })
  it('reports an out-of-memory event of the project', async () => {
    const probe = makeDockerProbe(async () => ({ ok: true, stdout: 'oom\n' }))
    expect(await probe.outOfMemorySince('rumba-x', Date.now() - 1000)).toBe(true)
  })
  it('names the command limit when a command timed out', () => {
    expect(classifyInfrastructure({ exitCode: 124, output: '', dockerOom: false })).toMatch(/command_timeout_minutes/)
  })
  it('does not take a lack of file watchers for a full disk', () => {
    expect(classifyInfrastructure({ exitCode: 1, output: 'Error: ENOSPC: System limit for number of file watchers reached', dockerOom: false })).toBeUndefined()
  })
})

describe('text from the ticket and the agent in the pull request', () => {
  it('escapes HTML in the summary, so it cannot load images or add links', () => {
    const d = makeDeps(); const s = { ...verified(d), fixSummary: 'Done <img src="https://evil.test/p.png"> <a href="https://x.test">x</a>' }
    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(body).not.toContain('<img'); expect(body).not.toContain('<a href')
  })
  it('keeps the ticket title from closing other issues, in the commit and the pull request title', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    const ticket = makeTicket({ title: 'Slug bug, fixes #42 and closes #43', ref: '#123' })
    await build(d, makeRumba(), ticket, failing(d))
    expect(d.workspace.commits.at(-1)).not.toMatch(/#4[23]\b/)
    await openPullRequest(d, makeRumba(), ticket, verified(d))
    expect(d.codeHost.prs[0]!.title).not.toMatch(/#4[23]\b/); expect(d.codeHost.prs[0]!.title).toContain('(#123)')
  })
})

describe('wiring', () => {
  const repo = { root: '/repo', owner: 'acme', name: 'shop', defaultBranch: 'main' }
  it('fails at once when only one commit author variable is set', () => {
    expect(() => buildDeps(makeRumba(), { GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', RUMBA_COMMIT_AUTHOR_NAME: 'Bot' }, repo)).toThrow(/RUMBA_COMMIT_AUTHOR_EMAIL/)
  })
  it('gives the docker environment the lock, the Docker probe and the disk check', () => {
    const d = buildDeps(makeRumba(), { GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a', RUMBA_HOME: '/tmp/rumba-home-test' }, repo)
    const o = (d.environment as unknown as { o: Record<string, unknown> }).o
    expect(o.lock).toBeInstanceOf(HostLock); expect(o.docker).toBeDefined(); expect(o.disk).toBeDefined(); expect(o.minFreeBytes).toBe(5 * 2 ** 30)
    const off = buildDeps(makeRumba({ environment: { ...makeRumba().environment, minFreeDiskGb: 0 } as never }), { GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a' }, repo)
    expect((off.environment as unknown as { o: Record<string, unknown> }).o.disk).toBeUndefined()
  })
})

describe('no change needed on a later run, decided from the branch', () => {
  it('re-verifies the fix committed in an earlier run when the agent says no change is needed', async () => {
    const d = makeDeps(); d.workspace.hashes = H; d.environment.passes = () => true
    d.workspace.branchTip = 'fix-from-run-3'
    d.agent.script.fix = { kind: 'fix', summary: 'The fix is already there.', noChangeNeeded: 'The checks pass; the tests were killed for memory.' }
    d.workspace.commitResults = [null]
    const st = { ...failing(d), attempts: [{ n: 1, outcome: 'infrastructure' as const, checks: [{ criterionId: 'c1', passed: true, exitCode: 0 }], projectTests: 'infrastructure' as const, tail: 'Killed' }] }
    const s = await build(d, withTests, makeTicket(), st)
    expect(s.state).toBe('verified')
    expect(d.environment.ups).toEqual([{ branch: 'rumba/shop/123', sha: 'fix-from-run-3', role: 'after' }])
  })
  it('keeps telling the agent the truth after it changed nothing, when the branch still holds a fix', async () => {
    const d = makeDeps(); d.workspace.hashes = H; d.environment.passes = () => true
    d.workspace.branchTip = 'fix-from-run-3'
    d.agent.script.fix = [{ kind: 'fix', summary: 'nothing' }, { kind: 'fix', summary: 'x' }]
    d.workspace.commitResults = [null]
    const st = { ...failing(d), attempts: [{ n: 1, outcome: 'infrastructure' as const, checks: [{ criterionId: 'c1', passed: true, exitCode: 0 }], projectTests: 'infrastructure' as const, tail: 'Killed' }] }
    await build(d, withTests, makeTicket(), st)
    expect(d.agent.calls[1]).toMatchObject({ checkStatus: [{ criterionId: 'c1', passed: true }] })
  })
})

describe('more lock edges', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'rumba-lock3-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  it('removes draft files left by a process that died between writing and linking', async () => {
    const file = path.join(dir, 'environment.lock')
    await writeFile(`${file}.999999.abc`, '{}')
    const lock = new HostLock({ file, pollMs: 10, isAlive: (pid) => pid !== 999999 })
    await lock.acquire(500); await lock.release()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(dir)).toEqual([])
  })
  it('does not remove a live lock that replaced the stale one it judged', async () => {
    const file = path.join(dir, 'environment.lock')
    await writeFile(file, JSON.stringify({ pid: 999999, host: 'h', at: 'x' }))
    const live = new HostLock({ file, pollMs: 10, isAlive: (pid) => pid !== 999999 })
    // Between judging the old lock stale and removing it, another waiter takes the lock.
    const slow = new HostLock({ file, pollMs: 10, isAlive: (pid) => pid !== 999999, beforeRemoveStale: async () => {
      const { unlink } = await import('node:fs/promises'); await unlink(file); await live.acquire(100)
    } })
    await expect(slow.acquire(150)).rejects.toThrow(/did not finish in time/)
    await live.release()
  })
})

describe('timeout wording', () => {
  it('does not blame the command limit alone, since the ticket may have run out of time', () => {
    expect(classifyInfrastructure({ exitCode: 124, output: '', dockerOom: false })).toMatch(/command limit or the ticket's time/)
  })
})

describe('a stale lock replaced at the same inode', () => {
  it('is not removed when its content changed after it was judged', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rumba-lock4-'))
    try {
      const file = path.join(dir, 'environment.lock')
      await writeFile(file, JSON.stringify({ pid: 999999, host: 'h', at: 'x' }))
      const live = JSON.stringify({ pid: process.pid, host: 'h', at: 'y', token: 'someone-else' })
      // As if the freed inode number went straight to another waiter's new lock.
      const slow = new HostLock({ file, pollMs: 10, isAlive: (pid) => pid !== 999999, beforeRemoveStale: async () => { await writeFile(file, live) } })
      await expect(slow.acquire(100)).rejects.toThrow(/did not finish in time/)
      const { readFile } = await import('node:fs/promises')
      expect(await readFile(file, 'utf8')).toBe(live)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
