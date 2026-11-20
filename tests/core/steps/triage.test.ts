import { describe, expect, it } from 'vitest'
import { newState } from '../../../src/core/states.js'
import { triage } from '../../../src/core/steps/triage.js'
import { resumeCriteria } from '../../../src/core/steps/resumeCriteria.js'
import { makeDeps, makeRumba, makeTicket } from '../../../src/testing/fakes.js'

const bug = {
  kind: 'triage' as const, workable: true, reason: '', ticketKind: 'bug' as const,
  criteria: [{ id: 'c1', text: 'Saving a profile no longer returns 500', checkable: true }],
}
const draft = { kind: 'draft-criteria' as const, criteria: [{ id: 'c1', text: 'Export button exists', checkable: true }] }

describe('triage', () => {
  it('sends a workable bug to criteria_ready without approval', async () => {
    const d = makeDeps(); d.agent.script.triage = bug
    const s = await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('criteria_ready'); expect(s.kind).toBe('bug'); expect(s.criteria).toEqual(bug.criteria)
    expect(d.tracker.criteriaPosts).toHaveLength(0)
  })
  it('skips an unworkable ticket and says why', async () => {
    const d = makeDeps(); d.agent.script.triage = { ...bug, workable: false, reason: 'needs a product decision' }
    const s = await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('skipped')
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba skipped this ticket: needs a product decision')
    expect(d.tracker.states.get('123')?.state).toBe('skipped')
  })
  it('parks a feature without criteria and posts a draft', async () => {
    const d = makeDeps()
    d.agent.script.triage = { ...bug, ticketKind: 'feature', criteria: null }
    d.agent.script['draft-criteria'] = draft
    const s = await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('awaiting_criteria'); expect(s.kind).toBe('feature')
    expect(d.tracker.criteriaPosts[0]!.criteria[0]!.text).toBe('Export button exists')
    expect(s.criteria).toHaveLength(1)
    expect(d.tracker.states.get('123')?.state).toBe('awaiting_criteria')
  })
  it('drafts for a bug that came back with an empty criteria list', async () => {
    const d = makeDeps()
    d.agent.script.triage = { ...bug, criteria: [] }
    d.agent.script['draft-criteria'] = draft
    const s = await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('awaiting_criteria'); expect(s.kind).toBe('bug')
  })
  it('prefers criteria written in the description', async () => {
    const d = makeDeps(); d.agent.script.triage = { ...bug, ticketKind: 'feature', criteria: null }
    const t = makeTicket({ body: '## Acceptance criteria\n- CSV has a header row' })
    const s = await triage(d, makeRumba(), t, newState('hub', d.clock()))
    expect(s.state).toBe('criteria_ready'); expect(s.criteria[0]!.text).toBe('CSV has a header row')
    expect(d.agent.calls.map((c) => c.kind)).toEqual(['triage'])
  })
  it('passes tracker documents and rumba context to the agent', async () => {
    const d = makeDeps(); d.agent.script.triage = bug; d.tracker.documents = [{ title: 'Spec', body: 'details' }]
    await triage(d, makeRumba({ context: 'Hub notes' }), makeTicket(), newState('hub', d.clock()))
    expect(d.agent.calls[0]!.documents).toEqual([{ title: 'Spec', body: 'details' }])
    expect(d.agent.calls[0]!.context).toBe('Hub notes')
    expect(d.agent.calls[0]!.environmentKind).toBe('docker')
  })
  it('gives draft-criteria the same documents', async () => {
    const d = makeDeps(); d.tracker.documents = [{ title: 'Spec', body: 'details' }]
    d.agent.script.triage = { ...bug, criteria: null }; d.agent.script['draft-criteria'] = draft
    await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(d.agent.calls[1]!.kind).toBe('draft-criteria')
    expect(d.agent.calls[1]!.documents).toEqual([{ title: 'Spec', body: 'details' }])
  })
  it('handles an empty ticket body', async () => {
    const d = makeDeps(); d.agent.script.triage = bug
    await expect(triage(d, makeRumba(), makeTicket({ body: '' }), newState('hub', d.clock()))).resolves.toMatchObject({ state: 'criteria_ready' })
  })
  it('does not mutate the state it is given', async () => {
    const d = makeDeps(); d.agent.script.triage = bug
    const start = newState('hub', d.clock())
    await triage(d, makeRumba(), makeTicket(), start)
    expect(start).toEqual(newState('hub', d.clock()))
  })
  it('removes a stale approval before parking a new draft', async () => {
    const d = makeDeps()
    d.agent.script.triage = { ...bug, ticketKind: 'feature', criteria: null }
    d.agent.script['draft-criteria'] = draft
    const t = makeTicket({ labels: ['rumba:hub', 'rumba-approved'] })
    const s = await triage(d, makeRumba(), t, newState('hub', d.clock()))
    expect(s.state).toBe('awaiting_criteria')
    expect(t.labels).not.toContain('rumba-approved')
    const resumed = await resumeCriteria(d, makeRumba(), t, s)
    expect(resumed.state).toBe('awaiting_criteria')
  })
  it('returns its state when the cleanup fails', async () => {
    const d = makeDeps(); d.agent.script.triage = bug
    d.workspace.cleanup = async () => { throw new Error('cannot delete') }
    expect((await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).state).toBe('criteria_ready')
  })
  it('parks a feature with derived criteria, posts them, and asks for no other draft', async () => {
    const d = makeDeps()
    const proposed = [{ id: 'c1', text: 'The orders page has an export button', checkable: true }]
    d.agent.script.triage = { ...bug, ticketKind: 'feature', criteria: proposed, criteriaSource: 'derived' }
    const t = makeTicket({ labels: ['rumba:hub', 'rumba-approved'] })
    const s = await triage(d, makeRumba(), t, newState('hub', d.clock()))
    expect(s.state).toBe('awaiting_criteria'); expect(s.kind).toBe('feature'); expect(s.criteria).toEqual(proposed)
    expect(d.tracker.criteriaPosts).toEqual([{ ticketId: '123', criteria: proposed }])
    expect(d.agent.calls.map((c) => c.kind)).toEqual(['triage'])
    expect(t.labels).not.toContain('rumba-approved')
    expect(d.tracker.states.get('123')?.state).toBe('awaiting_criteria')
  })
  it('parks a feature whose criteria have no source', async () => {
    const d = makeDeps(); d.agent.script.triage = { ...bug, ticketKind: 'feature' }
    const s = await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('awaiting_criteria'); expect(d.tracker.criteriaPosts[0]!.criteria).toEqual(bug.criteria)
    expect(d.agent.calls.map((c) => c.kind)).toEqual(['triage'])
  })
  it('sends a feature with written criteria to criteria_ready', async () => {
    const d = makeDeps(); d.agent.script.triage = { ...bug, ticketKind: 'feature', criteriaSource: 'written' }
    const s = await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('criteria_ready'); expect(s.criteria).toEqual(bug.criteria); expect(d.tracker.criteriaPosts).toHaveLength(0)
  })
  it('sends a bug with derived criteria to criteria_ready', async () => {
    const d = makeDeps(); d.agent.script.triage = { ...bug, criteriaSource: 'derived' }
    expect((await triage(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).state).toBe('criteria_ready')
  })
})

