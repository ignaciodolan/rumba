import { describe, expect, it } from 'vitest'
import { runRumba, TrackerIdentityError } from '../../src/core/runner.js'
import { newState, transition } from '../../src/core/states.js'
import { AgentError } from '../../src/ports/agent.js'
import { failing, happyTriage, makeDeps, makeRumba, makeTicket, scriptFeatureWithoutCriteria, scriptHappyBug } from '../../src/testing/fakes.js'

describe('runRumba', () => {
  it('advances a queued ticket and records it', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1', labels: ['rumba:hub'] }))
    const r = await runRumba(d, makeRumba())
    expect(r.advanced).toEqual([{ ticket: '1', from: 'queued', to: 'pr_open' }])
  })
  it('stops at max_tickets_per_run', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    for (const id of ['1', '2', '3']) d.tracker.tickets.push(makeTicket({ id, labels: ['rumba:hub'] }))
    const r = await runRumba(d, makeRumba({ limits: { maxTicketsPerRun: 2, minutesPerTicket: 30, maxFixAttempts: 2 } }))
    expect(r.advanced).toHaveLength(2); expect(r.left).toEqual([{ ticket: '3', why: 'run limit' }])
  })
  it('leaves a ticket claimed by two rumbas and says so once', async () => {
    const d = makeDeps(); const t = makeTicket({ id: '1', labels: ['rumba:hub', 'rumba:api'] }); d.tracker.tickets.push(t)
    const r = await runRumba(d, makeRumba()); await runRumba(d, makeRumba())
    expect(r.left).toEqual([{ ticket: '1', why: 'two rumbas' }])
    expect(d.tracker.comments.filter(c => c.body.includes('more than one rumba label'))).toHaveLength(1)
    expect(d.agent.calls).toHaveLength(0)
  })
  it('turns a thrown error into a count and keeps the last durable state', async () => {
    const d = makeDeps(); d.agent.script.triage = new AgentError('result.json missing')
    const t = makeTicket({ id: '1', labels: ['rumba:hub'] }); d.tracker.tickets.push(t)
    const r = await runRumba(d, makeRumba())
    expect(d.tracker.states.get('1')).toMatchObject({ state: 'queued', errorCount: 1 })
    expect(d.tracker.states.get('1')?.lease).toBeUndefined()
    expect(r.left).toEqual([{ ticket: '1', why: 'error: result.json missing' }])
  })
  it('moves to needs_human on the third error', async () => {
    const d = makeDeps(); d.agent.script.triage = new AgentError('bad json')
    d.tracker.tickets.push(makeTicket({ id: '1', labels: ['rumba:hub'] }))
    for (let i = 0; i < 3; i++) await runRumba(d, makeRumba())
    expect(d.tracker.states.get('1')?.state).toBe('needs_human')
    expect(d.tracker.comments.at(-1)?.body).toContain('bad json')
  })
  it('one failing ticket does not stop the next', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.agent.script.triage = [new AgentError('x'), happyTriage]
    d.tracker.tickets.push(makeTicket({ id: '1', labels: ['rumba:hub'] }), makeTicket({ id: '2', labels: ['rumba:hub'] }))
    const r = await runRumba(d, makeRumba()); expect(r.advanced.map(a => a.ticket)).toEqual(['2'])
  })
  it('resets a stale transient state and skips a fresh one', async () => {
    const d = makeDeps(); scriptHappyBug(d); const t = makeTicket({ id: '1', labels: ['rumba:hub'] }); d.tracker.tickets.push(t)
    const building = { ...failing(d), state: 'building' as const, lastDurable: 'criteria_ready' as const }
    d.tracker.states.set('1', { ...building, lease: { runId: 'other', at: '2026-01-01T00:00:00Z' } })
    expect((await runRumba(d, makeRumba())).left).toEqual([{ ticket: '1', why: 'in progress elsewhere' }])
    d.tracker.states.set('1', { ...building, lease: { runId: 'other', at: '2025-12-31T00:00:00Z' } })
    expect((await runRumba(d, makeRumba())).advanced[0]).toMatchObject({ ticket: '1', from: 'criteria_ready' })
  })
  it('restarts an ended ticket on rumba-retry and removes the label', async () => {
    const d = makeDeps(); scriptHappyBug(d); const t = makeTicket({ id: '1', labels: ['rumba:hub', 'rumba-retry'] }); d.tracker.tickets.push(t)
    d.tracker.states.set('1', { ...transition(newState('hub', d.clock()), 'needs_human', d.clock()), errorCount: 3, fixAttempts: 2 })
    const r = await runRumba(d, makeRumba())
    expect(r.advanced[0]).toMatchObject({ from: 'queued', to: 'pr_open' }); expect(t.labels).not.toContain('rumba-retry')
    expect(d.tracker.states.get('1')).toMatchObject({ fixAttempts: 0, errorCount: 0 })
  })
  it('creates labels before listing', async () => {
    const d = makeDeps(); const order: string[] = []
    d.tracker.ensureLabels = async () => { order.push('ensure') }; d.tracker.listCandidates = async () => { order.push('list'); return [] }
    await runRumba(d, makeRumba()); expect(order).toEqual(['ensure', 'list'])
  })
  it('leaves a ticket without the opt-in label untouched when asked for by id', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1', labels: ['bug'] }))
    const r = await runRumba(d, makeRumba(), { ticketId: '1' })
    expect(r).toEqual({ rumba: 'hub', advanced: [], left: [{ ticket: '1', why: 'no opt-in label' }] })
    expect(d.tracker.states.size).toBe(0); expect(d.agent.calls).toHaveLength(0)
  })
  it('advances a single ticket by id', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    d.tracker.tickets.push(makeTicket({ id: '1' }), makeTicket({ id: '2' }))
    const r = await runRumba(d, makeRumba(), { ticketId: '2' })
    expect(r.advanced.map(a => a.ticket)).toEqual(['2'])
  })
  it('starts afresh when the state belongs to another rumba', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    d.tracker.states.set('1', { ...newState('api', d.clock()), state: 'needs_human', lastDurable: 'needs_human' })
    const r = await runRumba(d, makeRumba())
    expect(r.advanced).toEqual([{ ticket: '1', from: 'queued', to: 'pr_open' }])
    expect(d.tracker.states.get('1')?.rumba).toBe('hub')
  })
  it('treats a transient state without a lease as stale', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    d.tracker.states.set('1', { ...failing(d), state: 'building', lastDurable: 'criteria_ready' })
    expect((await runRumba(d, makeRumba())).advanced[0]).toMatchObject({ from: 'criteria_ready' })
  })
  it('leaves ended and pr_open tickets with the state name and no limit cost', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    d.tracker.tickets.push(makeTicket({ id: '1' }), makeTicket({ id: '2' }), makeTicket({ id: '3' }))
    d.tracker.states.set('1', transition(newState('hub', d.clock()), 'needs_human', d.clock()))
    d.tracker.states.set('2', { ...newState('hub', d.clock()), state: 'pr_open', lastDurable: 'pr_open' })
    const r = await runRumba(d, makeRumba({ limits: { maxTicketsPerRun: 1, minutesPerTicket: 30, maxFixAttempts: 2 } }))
    expect(r.left).toEqual([{ ticket: '1', why: 'needs_human' }, { ticket: '2', why: 'pr_open' }])
    expect(r.advanced.map(a => a.ticket)).toEqual(['3'])
  })
  it('lists a ticket that stays in awaiting_criteria as left, with no lease', async () => {
    const d = makeDeps(); scriptFeatureWithoutCriteria(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    const r = await runRumba(d, makeRumba())
    expect(r).toMatchObject({ advanced: [], left: [{ ticket: '1', why: 'awaiting criteria' }] })
    expect(d.tracker.states.get('1')?.lease).toBeUndefined()
  })
  it('clears the lease after a successful advance', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    await runRumba(d, makeRumba())
    expect(d.tracker.states.get('1')?.lease).toBeUndefined()
  })
  it('redacts secrets in the error comment and the summary', async () => {
    const d = makeDeps({ secrets: ['s3cr3t'] }); d.agent.script.triage = new AgentError('leaked s3cr3t')
    d.tracker.tickets.push(makeTicket({ id: '1' }))
    d.tracker.states.set('1', { ...newState('hub', d.clock()), errorCount: 2 })
    const r = await runRumba(d, makeRumba())
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba hit repeated errors on this ticket: leaked [redacted]')
    expect(r.left).toEqual([{ ticket: '1', why: 'error: leaked [redacted]' }])
  })
  it('keeps durable progress made inside a failed call', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.agent.script['write-checks'] = new AgentError('boom')
    d.tracker.tickets.push(makeTicket({ id: '1' }))
    await runRumba(d, makeRumba())
    expect(d.tracker.states.get('1')).toMatchObject({ state: 'criteria_ready', errorCount: 1 })
  })
  it('carries on when handling one ticket throws outside advanceTicket', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    d.tracker.tickets.push(makeTicket({ id: '1' }), makeTicket({ id: '2' }))
    const read = d.tracker.readState.bind(d.tracker)
    d.tracker.readState = async (t) => { if (t.id === '1') throw new Error('tracker down'); return read(t) }
    const r = await runRumba(d, makeRumba())
    expect(r.left).toEqual([{ ticket: '1', why: 'error: tracker down' }])
    expect(r.advanced.map(a => a.ticket)).toEqual(['2'])
  })
  it('rejects when listing fails', async () => {
    const d = makeDeps(); d.tracker.listCandidates = async () => { throw new Error('nope') }
    await expect(runRumba(d, makeRumba())).rejects.toThrow('nope')
  })
  it('counts a ticket that threw toward max_tickets_per_run', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.agent.script.triage = [new AgentError('x'), happyTriage]
    for (const id of ['1', '2', '3']) d.tracker.tickets.push(makeTicket({ id }))
    const r = await runRumba(d, makeRumba({ limits: { maxTicketsPerRun: 2, minutesPerTicket: 30, maxFixAttempts: 2 } }))
    expect(r.advanced.map(a => a.ticket)).toEqual(['2'])
    expect(r.left).toEqual([{ ticket: '1', why: 'error: x' }, { ticket: '3', why: 'run limit' }])
  })
  it('counts a stale lease as an error', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    d.tracker.states.set('1', { ...failing(d), state: 'building', lastDurable: 'criteria_ready', errorCount: 1 })
    expect((await runRumba(d, makeRumba())).advanced[0]).toMatchObject({ from: 'criteria_ready', to: 'pr_open' })
    expect(d.tracker.states.get('1')?.errorCount).toBe(2)
  })
  it('moves a ticket interrupted for the third time to needs_human and says so', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    d.tracker.states.set('1', { ...failing(d), state: 'building', lastDurable: 'criteria_ready', errorCount: 2, lease: { runId: 'old', at: '2025-12-31T00:00:00Z' } })
    const r = await runRumba(d, makeRumba())
    expect(r).toEqual({ rumba: 'hub', advanced: [], left: [{ ticket: '1', why: 'needs_human' }] })
    expect(d.tracker.states.get('1')).toMatchObject({ state: 'needs_human', errorCount: 3 })
    expect(d.tracker.states.get('1')?.lease).toBeUndefined()
    expect(d.tracker.comments.map(c => c.body)).toEqual(['Rumba was interrupted repeatedly while working on this ticket.'])
    expect(d.agent.calls).toHaveLength(0)
  })
  it('rejects with TrackerIdentityError when it cannot read back the state it wrote', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }), makeTicket({ id: '2' }))
    d.tracker.readState = async () => null
    const err = await runRumba(d, makeRumba()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TrackerIdentityError)
    expect((err as Error).message).toContain('RUMBA_GITHUB_LOGIN')
    expect(d.agent.calls).toHaveLength(0)
  })
})

