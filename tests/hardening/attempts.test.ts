import { describe, expect, it } from 'vitest'
import { encodeStateComment, decodeStateComment } from '../../src/core/stateComment.js'
import { runRumba } from '../../src/core/runner.js'
import { build } from '../../src/core/steps/build.js'
import { checkEnvironment } from '../../src/core/steps/checkEnvironment.js'
import { reproduce } from '../../src/core/steps/reproduce.js'
import { newState, transition } from '../../src/core/states.js'
import { InfrastructureError } from '../../src/ports/environment.js'
import { failing, makeDeps, makeRumba, makeTicket, scriptHappyBug } from '../../src/testing/fakes.js'

const H = { 'tests/rumba/c1.test.ts': 'h1' }
const fix = { kind: 'fix' as const, summary: 'Lower-case the slug.' }
const withTests = makeRumba({ verify: { test: 'pnpm test' } })
const oom = { exitCode: 137, output: 'Killed', infrastructure: 'killed (exit 137: SIGKILL, usually the out-of-memory killer)' }

describe('infrastructure failures are not fix failures', () => {
  it('runs a check that died of infrastructure once more, and a pass then counts', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.checkResults = [{ passed: false, ...oom }]
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('verified'); expect(s.fixAttempts).toBe(0)
    expect(d.environment.checksRun).toEqual(['c1', 'c1'])
  })
  it('counts an error, not a fix attempt, when the project tests die of infrastructure twice', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    d.environment.commandResults = [oom, oom]
    const err = await build(d, withTests, makeTicket(), failing(d)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InfrastructureError)
    expect((err as Error).message).toMatch(/project tests.*out-of-memory killer/)
    const stored = d.tracker.states.get('123')!
    expect(stored.fixAttempts).toBe(0)
    expect(stored.attempts?.at(-1)).toMatchObject({ n: 1, outcome: 'infrastructure', projectTests: 'infrastructure', checks: [{ criterionId: 'c1', passed: true }] })
    // The second run is a fresh checkout and a fresh environment, never the same containers again.
    expect(d.environment.ups).toHaveLength(2); expect(d.environment.downs).toBe(2)
    expect(new Set(d.environment.upWorkdirs).size).toBe(2)
  })
  it('does not take a check that died of infrastructure on the base commit as evidence', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = { kind: 'write-checks', checks: [{ criterionId: 'c1', command: 'npm test -- c1', files: ['tests/rumba/c1.test.ts'] }] }
    d.workspace.hashes = H; d.environment.checkResults = [{ passed: false, ...oom }, { passed: false, ...oom }]
    const ready = { ...transition(transition(newState('shop', d.clock()), 'triaged', d.clock()), 'criteria_ready', d.clock()), kind: 'bug' as const, criteria: [{ id: 'c1', text: 'C1', checkable: true }] }
    await expect(reproduce(d, makeRumba(), makeTicket(), ready)).rejects.toBeInstanceOf(InfrastructureError)
  })
  it('counts infrastructure in the environment check as an error, not as tests that fail', async () => {
    const d = makeDeps(); d.environment.commandResults = [oom, oom]
    await expect(checkEnvironment(d, withTests, makeTicket(), newState('shop', d.clock()))).rejects.toBeInstanceOf(InfrastructureError)
    expect(d.tracker.comments).toEqual([])
  })
  it('rethrows an environment that did not come up for infrastructure, instead of a final needs_human', async () => {
    const d = makeDeps(); d.environment.upError = new InfrastructureError('Not enough disk space for Docker: 1.2 GB free, at least 5 GB needed.')
    await expect(checkEnvironment(d, withTests, makeTicket(), newState('shop', d.clock()))).rejects.toThrow(/Not enough disk/)
  })
  it('says plainly on the ticket that it was the infrastructure, and that it counts as an error', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    d.environment.upError = new InfrastructureError('Not enough disk space for Docker: 1.2 GB free, at least 5 GB needed.')
    await runRumba(d, makeRumba())
    expect(d.tracker.comments.at(-1)?.body).toBe(
      'Rumba stopped because of a problem with the machine, not with the change: Not enough disk space for Docker: 1.2 GB free, at least 5 GB needed. ' +
      'This counts as error 1 of 3, not as a fix attempt. The next run tries again.',
    )
    expect(d.tracker.states.get('1')).toMatchObject({ state: 'queued', errorCount: 1 })
  })
})

describe('a failing command is run once more before an attempt is charged', () => {
  it('re-runs a failing check, and a pass on the second run counts', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.checkResults = [{ passed: false, exitCode: 1, output: 'flaky' }]
    expect((await build(d, makeRumba(), makeTicket(), failing(d))).state).toBe('verified')
  })
  it('charges the attempt when the check fails both times', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => false
    const s = await build(d, makeRumba({ limits: { maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 1 } }), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed'); expect(d.environment.checksRun).toEqual(['c1', 'c1'])
  })
})

describe('every attempt is recorded on the ticket', () => {
  it('stores each attempt: the checks, the project tests, and a short tail of the output', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    d.environment.commandResults = [{ exitCode: 1, output: 'x'.repeat(5000) + ' FAIL orders.test.ts' }, { exitCode: 1, output: 'FAIL orders.test.ts' }]
    const s = await build(d, withTests, makeTicket(), failing(d))
    expect(s.state).toBe('verified')
    expect(s.attempts).toHaveLength(2)
    expect(s.attempts![0]).toMatchObject({ n: 1, outcome: 'project-tests-failed', projectTests: 'failed', checks: [{ criterionId: 'c1', passed: true, exitCode: 0 }] })
    expect(s.attempts![0]!.tail.length).toBeLessThanOrEqual(1200)
    expect(s.attempts![0]!.tail).toContain('FAIL orders.test.ts')
    expect(s.attempts![1]).toMatchObject({ n: 2, outcome: 'verified', projectTests: 'passed' })
  })
  it('explains a fix_failed from the ticket alone, attempt by attempt', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => false
    await build(d, makeRumba(), makeTicket(), failing(d))
    const comment = d.tracker.comments.at(-1)!.body
    expect(comment).toMatch(/Attempt 1: checks failed \(c1 failed\)/)
    expect(comment).toMatch(/Attempt 2: checks failed \(c1 failed\)/)
  })
  it('keeps the attempts in the state comment, dropping their output when the comment would be too long', () => {
    const d = makeDeps()
    const attempt = (n: number) => ({ n, outcome: 'checks-failed' as const, projectTests: 'not-run' as const, checks: [{ criterionId: 'c1', passed: false, exitCode: 1 }], tail: 'y'.repeat(1000) })
    const s = { ...failing(d), attempts: [attempt(1), attempt(2)], before: [{ criterionId: 'c1', passed: false, exitCode: 1, output: 'z'.repeat(59000) }] }
    const text = encodeStateComment(s)
    expect(text.length).toBeLessThanOrEqual(60000)
    expect(decodeStateComment(text)?.attempts?.map((a) => a.n)).toEqual([1, 2])
  })
})

describe('the fix agent is told the true situation', () => {
  it('says which checks pass and that only the project tests failed', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => true
    d.environment.commandResults = [{ exitCode: 1, output: 'FAIL' }, { exitCode: 1, output: 'FAIL' }, { exitCode: 0, output: '' }]
    await build(d, withTests, makeTicket(), failing(d))
    expect(d.agent.calls[1]).toMatchObject({ checkStatus: [{ criterionId: 'c1', passed: true }], projectTests: 'failed', attempt: 2 })
  })
  it('re-verifies once when the agent says no change is needed, and verifies if the code now passes', async () => {
    const d = makeDeps(); d.workspace.hashes = H; d.environment.passes = () => true
    d.agent.script.fix = [fix, { kind: 'fix', summary: 'The code is right; the test run crashed.', noChangeNeeded: 'The checks pass; the project tests were killed.' }]
    d.environment.commandResults = [{ exitCode: 1, output: 'FAIL' }, { exitCode: 1, output: 'FAIL' }, { exitCode: 0, output: '' }]
    d.workspace.commitResults = ['fix1', null]  // not the checks commit (sha1), so there is a fix to verify
    const s = await build(d, withTests, makeTicket(), failing(d))
    expect(s.state).toBe('verified')
    expect(s.attempts?.at(-1)).toMatchObject({ n: 2, outcome: 'verified', note: 'The agent said no change was needed: The checks pass; the project tests were killed.' })
  })
  it('ends in needs_human with the agent\'s reason, not a guard failure, when the re-verification still fails', async () => {
    const d = makeDeps(); d.workspace.hashes = H; d.environment.passes = () => true
    d.agent.script.fix = [fix, { kind: 'fix', summary: 'nothing', noChangeNeeded: 'The failing test is unrelated to this ticket.' }]
    d.environment.commandExit = 1; d.environment.commandOutput = 'FAIL other.test.ts'
    d.workspace.commitResults = ['fix1', null]  // not the checks commit (sha1), so there is a fix to verify
    const s = await build(d, withTests, makeTicket(), failing(d))
    expect(s.state).toBe('needs_human')
    expect(s.history.at(-1)?.note).toBe('agent says no change is needed')
    const comment = d.tracker.comments.at(-1)!.body
    expect(comment).toMatch(/^The agent says no change is needed: The failing test is unrelated to this ticket\./)
    expect(comment).toContain('FAIL other.test.ts')
    expect(comment).not.toMatch(/changed no files/)
  })
})

describe('a second run can not be gamed by the code under test', () => {
  it('runs the second try in a fresh checkout and environment, so state left by the first run is gone', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    // Code that fails the first time and leaves a marker to pass the second time, in the same environment.
    const markers = new Set<string>()
    d.environment.runCheck = async (h, check) => {
      const passed = markers.has(h.workdir)
      markers.add(h.workdir)
      return { criterionId: check.criterionId, passed, exitCode: passed ? 0 : 1, output: passed ? 'ok' : 'first run fails' }
    }
    const s = await build(d, makeRumba({ limits: { maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 1 } }), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed')
  })
})
