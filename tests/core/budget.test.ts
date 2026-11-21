import { describe, expect, it } from 'vitest'
import { advanceTicket } from '../../src/core/engine.js'
import { runRumba } from '../../src/core/runner.js'
import { newState } from '../../src/core/states.js'
import { AgentError } from '../../src/ports/agent.js'
import { failing, makeDeps, makeRumba, makeTicket, scriptHappyBug } from '../../src/testing/fakes.js'

// minutes_per_ticket bounds a ticket: every agent call and every environment command gets at
// most the time the ticket has left, and a call cut short by that is the budget running out,
// not an error.

const MIN = 60_000

describe('the time budget of a ticket', () => {
  it('gives each agent call and each environment the time left, not the whole budget', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    let minutes = 0
    d.clock = () => new Date(Date.UTC(2026, 0, 1, 0, minutes))
    const agentRun = d.agent.run.bind(d.agent)
    d.agent.run = async (task, w) => { const r = await agentRun(task, w); minutes += 5; return r }
    await advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    const limits = d.agent.calls.map((c) => c.timeoutMs)
    // triage at minute 0, write-checks at 5, fix at 10; the environment on the base at 0, before at 10, after at 15.
    expect(limits).toEqual([30 * MIN, 25 * MIN, 20 * MIN])
    expect(d.environment.upTimeouts).toEqual([30 * MIN, 20 * MIN, 15 * MIN])
  })
  it('ends the ticket in needs_human, not in an error, when a call is cut short by the budget', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    let minutes = 0
    d.clock = () => new Date(Date.UTC(2026, 0, 1, 0, minutes))
    d.agent.script['write-checks'] = new AgentError('Claude Code timed out after 1800000 ms')
    const agentRun = d.agent.run.bind(d.agent)
    d.agent.run = async (task, w) => { if (task.kind === 'write-checks') minutes = 31; return agentRun(task, w) }
    const s = await advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('needs_human'); expect(s.history.at(-1)?.note).toBe('time budget exceeded')
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba stopped work on this ticket: the time budget of 30 minutes ran out.')
  })
  it('still reports an error that happens with time left as an error', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.agent.script.triage = new AgentError('bad json')
    await expect(advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).rejects.toThrow('bad json')
  })
})

describe('the lease of a ticket', () => {
  const at = (minutesAgo: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) - minutesAgo * MIN).toISOString()

  it('lasts the budget plus the time to take the environment down, so a working run is never overtaken', async () => {
    const d = makeDeps(); scriptHappyBug(d); d.tracker.tickets.push(makeTicket({ id: '1' }))
    const rumba = makeRumba({ environment: { ...makeRumba().environment, kind: 'docker', commandTimeoutMinutes: 20 } as never })
    // Budget 30 minutes, down up to 20, plus 5 minutes of margin: a lease 50 minutes old is still held.
    d.tracker.states.set('1', { ...failing(d), state: 'building', lastDurable: 'criteria_ready', lease: { runId: 'other', at: at(50) } })
    expect((await runRumba(d, rumba)).left).toEqual([{ ticket: '1', why: 'in progress elsewhere' }])
    d.tracker.states.set('1', { ...failing(d), state: 'building', lastDurable: 'criteria_ready', lease: { runId: 'other', at: at(56) } })
    expect((await runRumba(d, rumba)).advanced[0]).toMatchObject({ ticket: '1', from: 'criteria_ready' })
  })
})
