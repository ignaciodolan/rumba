import { describe, expect, it } from 'vitest'
import { newState, transition } from '../../../src/core/states.js'
import { reproduce } from '../../../src/core/steps/reproduce.js'
import { makeDeps, makeRumba, makeTicket } from '../../../src/testing/fakes.js'

const ready = (d: ReturnType<typeof makeDeps>, kind: 'bug' | 'feature', n = 1) => ({
  ...transition(transition(newState('hub', d.clock()), 'triaged', d.clock()), 'criteria_ready', d.clock()), kind,
  criteria: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `C${i + 1}`, checkable: true })) })
const checksFor = (n: number) => ({ kind: 'write-checks' as const,
  checks: Array.from({ length: n }, (_, i) => ({ criterionId: `c${i + 1}`, command: `npm test -- c${i + 1}`, files: [`tests/rumba/c${i + 1}.test.ts`] })) })

describe('reproduce', () => {
  it('reaches checks_failing when every check fails on the base', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    const s = await reproduce(d, makeRumba(), makeTicket({ id: '123' }), ready(d, 'bug'))
    expect(s.state).toBe('checks_failing')
    expect(s.branch).toBe('rumba/hub/123'); expect(s.baseSha).toBe('base000'); expect(s.checksSha).toBe('sha1')
    expect(s.before).toEqual([expect.objectContaining({ criterionId: 'c1', passed: false })])
    expect(s.checkHashes).toEqual({ 'tests/rumba/c1.test.ts': 'h1' })
    expect(d.environment.ups).toEqual([{ branch: 'rumba/hub/123', sha: 'sha1', role: 'before' }]); expect(d.environment.downs).toBe(1)
  })
  it('marks a bug not_reproducible when its check passes', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.environment.passes = () => true
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.state).toBe('not_reproducible'); expect(d.tracker.comments.at(-1)?.body).toMatch(/could not reproduce/)
  })
  it('sends a feature to needs_human when a check already passes', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(2); d.environment.passes = c => c.criterionId === 'c2'
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'feature', 2))
    expect(s.state).toBe('needs_human'); expect(d.tracker.comments.at(-1)?.body).toContain('C2')
  })
  it('needs a human when nothing can be checked', async () => {
    const d = makeDeps(); const st = ready(d, 'feature'); st.criteria[0]!.checkable = false
    const s = await reproduce(d, makeRumba(), makeTicket(), st)
    expect(s.state).toBe('needs_human'); expect(d.agent.calls).toHaveLength(0)
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba could not write a check for any criterion.')
  })
  it('takes the environment down even when a check throws', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.environment.runCheck = async () => { throw new Error('boom') }
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow('boom')
    expect(d.environment.downs).toBe(1)
  })
  it('passes the checkable criteria and context to the agent', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    const st = ready(d, 'feature', 2); st.criteria[1]!.checkable = false
    await reproduce(d, makeRumba({ context: 'Hub notes' }), makeTicket(), st)
    expect(d.agent.calls[0]).toMatchObject({ kind: 'write-checks', context: 'Hub notes', environmentKind: 'docker', criteria: [st.criteria[0]] })
  })
  it('drops checks for unknown criteria and needs a human if none are left', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = { kind: 'write-checks', checks: [{ criterionId: 'zzz', command: 'x', files: [] }] }
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toHaveLength(0)
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba could not write a check for any criterion.')
  })
  it('uses the base sha when the agent needs no new files', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.workspace.commit = async () => null
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.checksSha).toBe('base000'); expect(d.environment.ups[0]!.sha).toBe('base000')
  })
  it('writes env_ready before running the checks', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    let seen: string | undefined
    d.environment.runCheck = async (_h, c) => { seen = d.tracker.states.get('123')?.state; return { criterionId: c.criterionId, passed: false, exitCode: 1, output: '' } }
    await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(seen).toBe('env_ready')
  })
  it('propagates an environment.up failure', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.environment.up = async () => { throw new Error('no env') }
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow('no env')
    expect(d.environment.downs).toBe(0)
  })
  it('removes secrets from stored output', async () => {
    const d = makeDeps(); d.secrets = ['s3cret']; d.agent.script['write-checks'] = checksFor(1)
    d.environment.runCheck = async (_h, c) => ({ criterionId: c.criterionId, passed: false, exitCode: 1, output: 'leaked s3cret here' })
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.before![0]!.output).not.toContain('s3cret')
    expect(d.tracker.states.get('123')?.before![0]!.output).not.toContain('s3cret')
  })
  it('rejects checks that touched a protected path before running them', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.changed = ['.rumba/hub/context.md']
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow(/\.rumba\/hub\/context\.md/)
    expect(d.environment.ups).toEqual([])
  })
  it('hashes declared check files and every file from the checks commit', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.changed = ['tests/rumba/helper.ts']
    const asked: string[][] = []
    d.workspace.hashFiles = async (_w, files) => { asked.push(files); return {} }
    await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(asked[0]).toEqual(expect.arrayContaining(['tests/rumba/c1.test.ts', 'tests/rumba/helper.ts']))
  })
  it('throws on a state that is not criteria_ready', async () => {
    const d = makeDeps()
    await expect(reproduce(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).rejects.toThrow()
  })
  it('does not mutate the state it is given', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    const start = ready(d, 'bug'); const copy = structuredClone(start)
    await reproduce(d, makeRumba(), makeTicket(), start)
    expect(start).toEqual(copy)
  })
})
