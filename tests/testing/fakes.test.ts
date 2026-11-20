import { describe, expect, it } from 'vitest'
import { newState, transition } from '../../src/core/states.js'
import { makeDeps, makeTicket } from '../../src/testing/fakes.js'

describe('fakes', () => {
  it('FakeAgent plays a script and records calls', async () => {
    const d = makeDeps()
    d.agent.script.fix = [{ kind: 'fix', summary: 'one' }, { kind: 'fix', summary: 'two' }]
    const task = { kind: 'fix' as const, ticket: makeTicket(), context: '', environmentKind: 'docker' as const }
    expect(await d.agent.run(task, '/w')).toEqual({ kind: 'fix', summary: 'one' })
    expect(await d.agent.run(task, '/w')).toEqual({ kind: 'fix', summary: 'two' })
    expect(await d.agent.run(task, '/w')).toEqual({ kind: 'fix', summary: 'two' })
    expect(d.agent.calls).toHaveLength(3)
  })

  it('FakeTracker keeps exactly one state label', async () => {
    const d = makeDeps()
    const t = makeTicket({ labels: ['rumba:hub'] })
    d.tracker.tickets.push(t)
    await d.tracker.writeState(t, newState('hub', d.clock()))
    await d.tracker.writeState(t, transition(newState('hub', d.clock()), 'triaged', d.clock()))
    expect(t.labels.filter((l) => l.startsWith('rumba-state:'))).toEqual(['rumba-state:triaged'])
  })

  it('FakeEnvironment fails before and passes after by default', async () => {
    const d = makeDeps()
    const c = { criterionId: 'c1', command: 'x', files: [] }
    const a = await d.environment.up({ branch: 'b', sha: '1', role: 'before' }, '/w')
    expect((await d.environment.runCheck(a, c)).passed).toBe(false)
    const b = await d.environment.up({ branch: 'b', sha: '2', role: 'after' }, '/w')
    expect((await d.environment.runCheck(b, c)).passed).toBe(true)
  })

  it('FakeAgent throws a named error when no script exists and throws Error items', async () => {
    const d = makeDeps()
    const task = { kind: 'triage' as const, ticket: makeTicket(), context: '', environmentKind: 'docker' as const }
    await expect(d.agent.run(task, '/w')).rejects.toThrow('triage')
    d.agent.script.triage = new Error('boom')
    await expect(d.agent.run(task, '/w')).rejects.toThrow('boom')
  })

  it('FakeTracker lists open opted-in candidates, stores copies, and dedupes commentOnce', async () => {
    const d = makeDeps()
    const a = makeTicket({ id: '1' })
    const b = makeTicket({ id: '2' })
    const c = makeTicket({ id: '3', labels: [] })
    d.tracker.tickets.push(a, b, c)
    d.tracker.closed.add('2')
    expect((await d.tracker.listCandidates()).map((t) => t.id)).toEqual(['1'])
    await expect(d.tracker.getTicket('nope')).rejects.toThrow()
    expect(await d.tracker.readState(a)).toBeNull()
    const s = newState('hub', d.clock())
    await d.tracker.writeState(a, s)
    const read = await d.tracker.readState(a)
    expect(read).toEqual(s)
    expect(read).not.toBe(d.tracker.states.get('1'))
    await d.tracker.commentOnce(a, 'k', 'x')
    await d.tracker.commentOnce(a, 'k', 'y')
    expect(d.tracker.comments).toEqual([{ ticketId: '1', body: 'x' }])
  })
})
