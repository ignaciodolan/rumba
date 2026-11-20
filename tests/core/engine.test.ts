import { describe, expect, it } from 'vitest'
import { advanceTicket } from '../../src/core/engine.js'
import { newState, transition } from '../../src/core/states.js'
import { makeDeps, makeRumba, makeTicket, scriptFeatureWithoutCriteria, scriptHappyBug } from '../../src/testing/fakes.js'

describe('advanceTicket', () => {
  it('takes a bug from queued to pr_open in one call', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    const s = await advanceTicket(d, makeRumba(), makeTicket({ id: '123' }), newState('hub', d.clock()))
    expect(s.state).toBe('pr_open')
    expect(s.history.map((h) => h.state)).toEqual(['triaged', 'criteria_ready', 'env_ready', 'checks_failing', 'building', 'verified', 'pr_open'])
    expect(d.codeHost.prs).toHaveLength(1)
    expect(d.workspace.cleanedAll).toBe(1)
  })
  it('stops at awaiting_criteria', async () => {
    const d = makeDeps(); scriptFeatureWithoutCriteria(d)
    expect((await advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).state).toBe('awaiting_criteria')
  })
  it('continues from awaiting_criteria once approved', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    const parked = { ...transition(transition(newState('hub', d.clock()), 'triaged', d.clock()), 'awaiting_criteria', d.clock()), kind: 'bug' as const, criteria: [{ id: 'c1', text: 'C1', checkable: true }] }
    const s = await advanceTicket(d, makeRumba(), makeTicket({ labels: ['rumba:hub', 'rumba-approved'] }), parked)
    expect(s.state).toBe('pr_open')
  })
  it('stops with needs_human when the time budget is spent', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    let calls = 0; d.clock = () => new Date(Date.UTC(2026, 0, 1, 0, calls++ * 20))
    const s = await advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('needs_human'); expect(s.history.at(-1)?.note).toBe('time budget exceeded')
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba stopped work on this ticket: the time budget of 30 minutes ran out.')
    expect(d.tracker.states.get('123')?.state).toBe('needs_human')
    expect(d.workspace.cleanedAll).toBe(1)
  })
  it('throws on a state it has no step for, and still cleans up', async () => {
    const d = makeDeps()
    const s = transition(newState('hub', d.clock()), 'triaged', d.clock())
    await expect(advanceTicket(d, makeRumba(), makeTicket(), s)).rejects.toThrow(/triaged/)
    expect(d.workspace.cleanedAll).toBe(1)
  })
  it('lets step errors propagate and still cleans up', async () => {
    const d = makeDeps()
    await expect(advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).rejects.toThrow()
    expect(d.workspace.cleanedAll).toBe(1)
  })
  it('returns an end state unchanged', async () => {
    const d = makeDeps()
    const s = transition(newState('hub', d.clock()), 'needs_human', d.clock())
    expect(await advanceTicket(d, makeRumba(), makeTicket(), s)).toBe(s)
  })
})
