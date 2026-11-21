import { describe, expect, it } from 'vitest'
import { renderPullRequestBody } from '../../../src/core/evidence.js'
import { decodeStateComment, encodeStateComment } from '../../../src/core/stateComment.js'
import { newState } from '../../../src/core/states.js'
import { reproduce } from '../../../src/core/steps/reproduce.js'
import { triage } from '../../../src/core/steps/triage.js'
import { makeDeps, makeRumba, makeTicket, verified } from '../../../src/testing/fakes.js'

// A written criterion can be a constraint on how the work is done rather than a behaviour a
// command can check, such as "nothing calls the network". Triage may mark such a criterion as
// not checkable, with a reason. It is then listed as not verified, the pull request is a
// draft, and it never counts as passed.

const body = [
  '## Acceptance criteria',
  '- Publishing a deal creates a public page',
  '- Tests use a fake Notion client; nothing calls the network',
].join('\n')
const feature = { kind: 'triage' as const, workable: true, reason: '', ticketKind: 'feature' as const, criteria: null }

describe('triage marks a written criterion as not checkable', () => {
  it('keeps the written criteria, marks the named one not checkable with its reason, and needs no approval', async () => {
    const d = makeDeps()
    d.agent.script.triage = { ...feature, notCheckable: [{ id: 'c2', reason: 'A constraint on the tests, not a behaviour a command can observe.' }] }
    const s = await triage(d, makeRumba(), makeTicket({ body }), newState('hub', d.clock()))
    expect(s.state).toBe('criteria_ready')
    expect(s.criteria).toEqual([
      { id: 'c1', text: 'Publishing a deal creates a public page', checkable: true },
      { id: 'c2', text: 'Tests use a fake Notion client; nothing calls the network', checkable: false, reason: 'A constraint on the tests, not a behaviour a command can observe.' },
    ])
  })
  it('shows the agent the written criteria with their ids, so it can name them', async () => {
    const d = makeDeps(); d.agent.script.triage = feature
    await triage(d, makeRumba(), makeTicket({ body }), newState('hub', d.clock()))
    expect(d.agent.calls[0]!.criteria?.map((c) => c.id)).toEqual(['c1', 'c2'])
  })
  it('ignores ids that name no written criterion, and never rewords a criterion', async () => {
    const d = makeDeps()
    d.agent.script.triage = { ...feature, criteria: [{ id: 'c1', text: 'something else', checkable: true }], notCheckable: [{ id: 'c9', reason: 'x' }] }
    const s = await triage(d, makeRumba(), makeTicket({ body }), newState('hub', d.clock()))
    expect(s.criteria.map((c) => [c.text, c.checkable])).toEqual([
      ['Publishing a deal creates a public page', true], ['Tests use a fake Notion client; nothing calls the network', true],
    ])
  })
  it('lets the remaining criteria be checked, so a passing constraint no longer stops the ticket', async () => {
    const d = makeDeps()
    d.agent.script.triage = { ...feature, notCheckable: [{ id: 'c2', reason: 'constraint' }] }
    const ready = await triage(d, makeRumba(), makeTicket({ body }), newState('hub', d.clock()))
    d.agent.script['write-checks'] = { kind: 'write-checks', checks: [{ criterionId: 'c1', command: 'npm test -- c1', files: ['tests/rumba/c1.test.ts'] }] }
    const s = await reproduce(d, makeRumba(), makeTicket({ body }), ready)
    expect(s.state).toBe('checks_failing')
    expect(d.agent.calls.at(-1)!.criteria?.map((c) => c.id)).toEqual(['c1'])
  })
})

describe('a criterion marked not checkable', () => {
  it('is listed as not verified with its reason, and makes the pull request a draft', () => {
    const d = makeDeps()
    const s = verified(d)
    s.criteria = [s.criteria[0]!, { id: 'c2', text: 'Nothing calls the network', checkable: false, reason: 'a constraint on the tests' }]
    const out = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(out).toMatch(/## Not verified[\s\S]*- Nothing calls the network \(not checkable: a constraint on the tests\)/)
  })
  it('keeps its reason in the state comment', () => {
    const d = makeDeps()
    const s = { ...newState('hub', d.clock()), criteria: [{ id: 'c1', text: 'T', checkable: false, reason: 'why' }] }
    expect(decodeStateComment(encodeStateComment(s))?.criteria).toEqual([{ id: 'c1', text: 'T', checkable: false, reason: 'why' }])
  })
})
