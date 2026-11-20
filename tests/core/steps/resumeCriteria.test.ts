import { describe, expect, it } from 'vitest'
import { newState, transition } from '../../../src/core/states.js'
import { resumeCriteria } from '../../../src/core/steps/resumeCriteria.js'
import { makeDeps, makeRumba, makeTicket } from '../../../src/testing/fakes.js'

const parked = (d: ReturnType<typeof makeDeps>) => ({
  ...transition(transition(newState('hub', d.clock()), 'triaged', d.clock()), 'awaiting_criteria', d.clock()),
  kind: 'feature' as const, criteria: [{ id: 'c1', text: 'Draft', checkable: true }],
})

describe('resumeCriteria', () => {
  it('waits without the approved label', async () => {
    const d = makeDeps(); const s = await resumeCriteria(d, makeRumba(), makeTicket(), parked(d))
    expect(s.state).toBe('awaiting_criteria')
  })
  it('accepts the draft once approved', async () => {
    const d = makeDeps(); const s = await resumeCriteria(d, makeRumba(), makeTicket({ labels: ['rumba:hub', 'rumba-approved'] }), parked(d))
    expect(s.state).toBe('criteria_ready'); expect(s.criteria[0]!.text).toBe('Draft')
    expect(d.tracker.states.get('123')?.state).toBe('criteria_ready')
  })
  it('uses the description section over the draft once approved', async () => {
    const d = makeDeps()
    const t = makeTicket({ labels: ['rumba:hub', 'rumba-approved'], body: '## Acceptance criteria\n- Final wording' })
    const s = await resumeCriteria(d, makeRumba(), t, parked(d))
    expect(s.criteria.map((c) => c.text)).toEqual(['Final wording'])
  })
  it('throws when the state is not awaiting_criteria', async () => {
    const d = makeDeps()
    await expect(resumeCriteria(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).rejects.toThrow()
  })
})
