import { describe, expect, it } from 'vitest'
import { advanceTicket } from '../../../src/core/engine.js'
import { newState } from '../../../src/core/states.js'
import { checkEnvironment } from '../../../src/core/steps/checkEnvironment.js'
import { makeDeps, makeRumba, makeTicket, scriptHappyBug } from '../../../src/testing/fakes.js'

// Before any agent call, the environment is brought up once on the base commit and the
// project's own tests are run there. A project that cannot start, or whose tests already
// fail, needs a person; spending agent calls on it would only end in errors or fix_failed.

const withTests = makeRumba({ verify: { test: 'pnpm test' } })

describe('checkEnvironment', () => {
  it('brings the environment up on the base commit, runs the project tests, and takes it down', async () => {
    const d = makeDeps()
    const s = await checkEnvironment(d, withTests, makeTicket({ id: '7' }), newState('shop', d.clock()))
    expect(s.state).toBe('queued')
    expect(d.environment.ups).toEqual([{ branch: 'rumba/shop/7', sha: 'base000', role: 'base' }])
    expect(d.environment.commandsRun).toEqual(['pnpm test'])
    expect(d.environment.downs).toBe(1)
    expect(d.workspace.log).toEqual(['prepare rumba/shop/7 fresh /fake/1/rumba/shop/7', 'cleanup /fake/1/rumba/shop/7'])
    expect(d.agent.calls).toHaveLength(0)
  })
  it('only brings the environment up when there are no project tests', async () => {
    const d = makeDeps()
    expect((await checkEnvironment(d, makeRumba(), makeTicket(), newState('shop', d.clock()))).state).toBe('queued')
    expect(d.environment.ups).toHaveLength(1); expect(d.environment.commandsRun).toEqual([]); expect(d.environment.downs).toBe(1)
  })
  it('stops with needs_human and the cleaned output when the environment does not come up', async () => {
    const d = makeDeps(); d.secrets = ['s3cret']
    d.environment.upError = new Error('open .rumba/shop/compose.yml: no such file or directory (token s3cret)')
    const s = await checkEnvironment(d, withTests, makeTicket(), newState('shop', d.clock()))
    expect(s).toMatchObject({ state: 'needs_human' })
    expect(s.history.at(-1)?.note).toBe('environment did not start')
    const comment = d.tracker.comments.at(-1)!.body
    expect(comment).toMatch(/^Rumba could not bring this project's environment up on the default branch/)
    expect(comment).toContain('no such file or directory'); expect(comment).not.toContain('s3cret')
    expect(d.tracker.states.get('123')?.state).toBe('needs_human')
  })
  it('stops with needs_human when the project tests already fail on the default branch', async () => {
    const d = makeDeps(); d.environment.commandExit = 1; d.environment.commandOutput = '31 workers killed'
    const s = await checkEnvironment(d, withTests, makeTicket(), newState('shop', d.clock()))
    expect(s.state).toBe('needs_human'); expect(s.history.at(-1)?.note).toBe('project tests fail on the default branch')
    expect(d.tracker.comments.at(-1)!.body).toMatch(/project's tests \(pnpm test\) already fail on the default branch[\s\S]*31 workers killed/)
    expect(d.environment.downs).toBe(1)
  })
  it('does nothing for an environment that cannot run commands', async () => {
    const d = makeDeps()
    const vercel = makeRumba({ environment: { kind: 'vercel-preview', protected: [] }, verify: { test: 'npm test' } })
    expect((await checkEnvironment(d, vercel, makeTicket(), newState('shop', d.clock()))).state).toBe('queued')
    expect(d.environment.ups).toEqual([])
  })
})

describe('advanceTicket and the environment check', () => {
  it('checks the environment before triage, and spends no agent call when it fails', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.environment.upError = new Error('port in use')
    const s = await advanceTicket(d, withTests, makeTicket(), newState('shop', d.clock()))
    expect(s.state).toBe('needs_human'); expect(d.agent.calls).toHaveLength(0)
  })
  it('checks it once, then works the ticket as before', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    const s = await advanceTicket(d, withTests, makeTicket(), newState('shop', d.clock()))
    expect(s.state).toBe('pr_open')
    expect(d.environment.ups.map((u) => u.role)).toEqual(['base', 'before', 'after'])
  })
})
