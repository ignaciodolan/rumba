import { describe, expect, it } from 'vitest'
import { advanceTicket } from '../../../src/core/engine.js'
import { openPullRequest } from '../../../src/core/steps/openPullRequest.js'
import { reproduce } from '../../../src/core/steps/reproduce.js'
import { newState, transition } from '../../../src/core/states.js'
import { decodeStateComment, encodeStateComment } from '../../../src/core/stateComment.js'
import { relocateChecks } from '../../../src/core/steps/relocateChecks.js'
import type { TicketState } from '../../../src/core/types.js'
import { AgentError, type AgentResult } from '../../../src/ports/agent.js'
import { type FakeDeps, makeDeps, makeRumba, makeTicket, verified } from '../../../src/testing/fakes.js'

const FROM = 'tests/rumba/c1.test.ts'
const TO = 'test/profile.test.ts'
const ORIGINAL = "import { expect, it } from 'vitest'\nimport { save } from '../../src/profile'\n\nit('c1', async () => {\n  expect((await save()).status).toBe(200)\n})\n"
const EXISTING = "import { expect, it } from 'vitest'\nimport { load } from '../src/profile'\n\nit('loads', async () => {\n  expect((await load()).status).toBe(200)\n})\n"
const MERGED = "import { expect, it } from 'vitest'\nimport { load, save } from '../src/profile'\n\nit('loads', async () => {\n  expect((await load()).status).toBe(200)\n})\n\nit('saves a profile with status 200', async () => {\n  expect((await save()).status).toBe(200)\n})\n"
/** The same merge, with the assertion weakened. */
const WEAKENED = MERGED.replace('expect((await save()).status).toBe(200)', 'expect((await save()).status).toBeDefined()')

const FIX = 'fix000'
const RELOCATED = 'reloc00'
const RELOCATED_AT_BASE = 'relbase'

const moved: Extract<AgentResult, { kind: 'relocate-checks' }> = {
  kind: 'relocate-checks',
  moves: [{ from: FROM, to: TO }],
  checks: [{ criterionId: 'c1', command: `npx vitest run ${TO}`, files: [TO] }],
}

/** A verified ticket whose fix is commit FIX, and an agent that merges the check into the project's test file. */
function setup(merged = MERGED): { d: FakeDeps; state: TicketState } {
  const d = makeDeps()
  const state = verified(d)
  state.checks = [{ criterionId: 'c1', command: `npx vitest run ${FROM}`, files: [FROM] }]
  state.checkHashes = { [FROM]: 'h1' }
  d.workspace.branchTip = FIX
  d.workspace.commitResults = [RELOCATED, RELOCATED_AT_BASE]
  d.workspace.changed = [FROM, TO]
  d.workspace.files = { [FIX]: { [FROM]: ORIGINAL, [TO]: EXISTING }, [RELOCATED]: { [TO]: merged } }
  d.agent.script['relocate-checks'] = moved
  return { d, state }
}

describe('relocateChecks', () => {
  it('moves the checks into the project tests, runs them on the change and on the base commit, and keeps them', async () => {
    const { d, state } = setup()
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)

    expect(s.state).toBe('verified')
    expect(s.checks).toEqual(moved.checks)
    expect(s.relocation).toMatchObject({ status: 'relocated', from: FIX, sha: RELOCATED, moves: moved.moves, original: state.checks })
    // Before stays the base run of the check Rumba wrote; after is the relocated check on the change.
    expect(s.before).toEqual(state.before)
    expect(s.after).toEqual([expect.objectContaining({ criterionId: 'c1', passed: true })])
    expect(s.relocation?.before).toEqual([expect.objectContaining({ criterionId: 'c1', passed: false })])
    expect(d.workspace.branchTip).toBe(RELOCATED)

    const task = d.agent.calls[0]!
    expect(task).toMatchObject({ kind: 'relocate-checks', checks: state.checks, criteria: state.criteria, execPrefix: 'docker compose exec app sh -c' })
    // On the change, in the relocated commit; on the base, in a commit of the checks commit with the relocated files.
    expect(d.environment.ups).toEqual([
      { branch: 'rumba/hub/123', sha: RELOCATED, role: 'after' },
      { branch: 'rumba/hub/123-relocated-base', sha: RELOCATED_AT_BASE, role: 'before' },
    ])
    expect(d.workspace.log).toContain(`reset /fake/3/rumba/hub/123-relocated-base sha1`)
    expect(d.workspace.log).toContain(`checkout /fake/3/rumba/hub/123-relocated-base ${RELOCATED} ${TO} ${FROM}`)
    // The environment never runs where the agent wrote: the agent's checkout is gone before the next one is made.
    expect(d.environment.upWorkdirs).not.toContain(d.agent.workdirs[0])
    const log = d.workspace.log
    expect(log.indexOf(`cleanup ${d.agent.workdirs[0]}`)).toBeGreaterThan(-1)
    expect(log.indexOf(`cleanup ${d.agent.workdirs[0]}`)).toBeLessThan(log.indexOf('prepare rumba/hub/123 existing /fake/2/rumba/hub/123'))
    expect(d.tracker.states.get('123')?.relocation?.status).toBe('relocated')
  })

  it('rejects a relocation that weakens a check, puts the branch back on the fix and runs nothing', async () => {
    const { d, state } = setup(WEAKENED)
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)

    expect(s.relocation).toMatchObject({ status: 'rejected', from: FIX })
    expect(s.relocation?.reason).toContain('toBeDefined()')
    expect(s.checks).toEqual(state.checks)
    expect(s.after).toEqual(state.after)
    expect(d.workspace.resets.at(-1)).toBe(FIX)
    expect(d.workspace.branchTip).toBe(FIX)
    expect(d.environment.ups).toEqual([])
  })

  it('rejects a relocated check that passes on the base commit too', async () => {
    // Every line kept, but the block placed where it no longer runs (inside an existing
    // describe.skip, say): only the run on the base commit can tell.
    const { d, state } = setup()
    d.environment.passes = () => true
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(s.relocation).toMatchObject({ status: 'rejected' })
    expect(s.relocation?.reason).toMatch(/c1 passes on the base commit/)
    expect(d.workspace.branchTip).toBe(FIX)
  })

  it('rejects a command that is not the verified one with the new path, before anything runs', async () => {
    const { d, state } = setup()
    d.agent.script['relocate-checks'] = { ...moved, checks: [{ criterionId: 'c1', command: `npx vitest run ${TO} || true`, files: [TO] }] }
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(s.relocation?.reason).toContain('must be the verified one with only the file paths changed')
    expect(d.environment.ups).toEqual([])
  })

  it('rejects a relocated check that fails on the change', async () => {
    const { d, state } = setup()
    d.environment.passes = () => false
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(s.relocation?.reason).toMatch(/c1 fails on the change/)
    expect(d.environment.ups).toHaveLength(1)
    expect(d.workspace.branchTip).toBe(FIX)
  })

  it('rejects a relocated check that no longer runs', async () => {
    const { d, state } = setup()
    d.environment.checkResults = [{ passed: false, exitCode: 127, output: 'vitest: not found' }]
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(s.relocation?.reason).toMatch(/c1 could not run on the change \(exit 127\)/)
  })

  it("rejects a relocation that breaks the project's own tests", async () => {
    const { d, state } = setup()
    d.environment.commandExit = 1
    d.environment.commandOutput = 'FAIL test/profile.test.ts > loads'
    const s = await relocateChecks(d, makeRumba({ verify: { test: 'npm test' } }), makeTicket(), state)
    expect(s.relocation?.reason).toMatch(/project's own tests fail/)
    expect(d.environment.commandsRun).toEqual(['npm test'])
  })

  it('falls back when the machine fails during a run, the agent fails, or the agent moves nothing', async () => {
    const infra = setup()
    infra.d.environment.checkResults = [{ passed: false, exitCode: 137, infrastructure: 'it ran out of memory' }]
    expect((await relocateChecks(infra.d, makeRumba(), makeTicket(), infra.state)).relocation?.reason).toMatch(/ran out of memory/)

    const agent = setup()
    agent.d.agent.script['relocate-checks'] = new AgentError('The agent did not write .rumba-out/result.json.')
    expect((await relocateChecks(agent.d, makeRumba(), makeTicket(), agent.state)).relocation?.reason).toMatch(/did not write/)

    const nothing = setup()
    nothing.d.workspace.commitResults = [null]
    expect((await relocateChecks(nothing.d, makeRumba(), makeTicket(), nothing.state)).relocation?.reason).toMatch(/moved nothing/)
    for (const x of [infra, agent, nothing]) expect(x.d.workspace.branchTip).toBe(FIX)
  })

  it('puts the branch back and falls back when an earlier relocation was interrupted', async () => {
    const { d, state } = setup()
    d.workspace.branchTip = RELOCATED
    const s = await relocateChecks(d, makeRumba(), makeTicket(), { ...state, relocation: { status: 'started', from: FIX } })
    expect(s.relocation).toMatchObject({ status: 'rejected', from: FIX })
    expect(s.relocation?.reason).toMatch(/interrupted/)
    expect(d.workspace.branchTip).toBe(FIX)
    expect(d.agent.calls).toHaveLength(0)
  })

  it('records the start before the agent runs, so an interrupted relocation can be undone', async () => {
    const { d, state } = setup()
    d.agent.run = async () => { throw new Error('process killed') }
    const writes: (string | undefined)[] = []
    const write = d.tracker.writeState.bind(d.tracker)
    d.tracker.writeState = async (t, s) => { writes.push(s.relocation?.status); await write(t, s) }
    await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(writes).toEqual(['started', 'rejected'])
  })

  it('throws, and records nothing, when the branch cannot be put back on the fix', async () => {
    const { d, state } = setup(WEAKENED)
    d.workspace.reset = async () => { throw new Error('reset failed') }
    await expect(relocateChecks(d, makeRumba(), makeTicket(), state)).rejects.toThrow('reset failed')
    expect(d.tracker.states.get('123')?.relocation?.status).toBe('started')
  })

  it('keeps the relocation on the ticket through the state comment', async () => {
    const { d, state } = setup()
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
})

describe('relocation and the rest of the ticket', () => {
  it('starts the base run on a branch that starts where the fix branch did', async () => {
    const { d, state } = setup()
    await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(d.workspace.log).toContain('prepare rumba/hub/123-relocated-base fresh like rumba/hub/123 /fake/3/rumba/hub/123-relocated-base')
  })

  it('warns about a check moved outside the paths of the rumba, like any other change', async () => {
    const { d, state } = setup()
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    d.workspace.changed = ['src/profile.ts', TO]
    await openPullRequest(d, makeRumba({ paths: ['src/**'] }), makeTicket(), s)
    expect(d.codeHost.prs[0]!.body).toMatch(/## Outside this rumba's scope[\s\S]*test\/profile\.test\.ts/)
  })

  it('forgets a relocation from an earlier run once the branch is made again', async () => {
    const d = makeDeps()
    d.agent.script['write-checks'] = { kind: 'write-checks', checks: [{ criterionId: 'c1', command: `npx vitest run ${FROM}`, files: [FROM] }] }
    const now = d.clock()
    const ready: TicketState = {
      ...transition(transition(newState('hub', now), 'triaged', now), 'criteria_ready', now), kind: 'bug',
      criteria: [{ id: 'c1', text: 'C1', checkable: true }],
      relocation: { status: 'relocated', from: 'old-fix', sha: 'old-move', moves: moved.moves, original: [] },
    }
    const s = await reproduce(d, makeRumba(), makeTicket(), ready)
    expect(s.state).toBe('checks_failing')
    expect(s.relocation).toBeUndefined()
  })
})

describe('the engine, from verified', () => {
  it('relocates the checks, then opens the pull request with the final files and the relocation in it', async () => {
    const { d, state } = setup()
    const s = await advanceTicket(d, makeRumba(), makeTicket(), state)
    expect(s.state).toBe('pr_open')
    expect(d.agent.calls.map((c) => c.kind)).toEqual(['relocate-checks'])
    const body = d.codeHost.prs[0]!.body
    expect(body).toContain(`| C1 | \`npx vitest run ${TO}\` | \`${TO}\` (relocated from \`${FROM}\`) | fail | pass |`)
    expect(body).toMatch(/## Checks[\s\S]*moved them into the project's tests/)
    expect(body).toMatch(/line by line/)
    expect(body).toMatch(/fails on the base commit/)
  })

  it('opens the pull request with the original checks, and says why, when the relocation is rejected', async () => {
    const { d, state } = setup(WEAKENED)
    const s = await advanceTicket(d, makeRumba(), makeTicket(), state)
    expect(s.state).toBe('pr_open')
    expect(d.codeHost.pushed).toHaveLength(1)
    const body = d.codeHost.prs[0]!.body
    expect(body).toContain(`| C1 | \`npx vitest run ${FROM}\` | \`${FROM}\` | fail | pass |`)
    expect(body).toMatch(/## Checks[\s\S]*rejected[\s\S]*toBeDefined\(\)/)
    expect(body).toMatch(/as Rumba wrote them/)
  })

  it('does not relocate when checks.relocate is false', async () => {
    const { d, state } = setup()
    const s = await advanceTicket(d, makeRumba({ checks: { relocate: false } }), makeTicket(), state)
    expect(s.state).toBe('pr_open')
    expect(d.agent.calls).toHaveLength(0)
    expect(s.relocation).toBeUndefined()
    expect(d.codeHost.prs[0]!.body).not.toContain('## Checks')
  })

  it('does not relocate again once it has decided', async () => {
    const { d, state } = setup()
    const s = await advanceTicket(d, makeRumba(), makeTicket(), { ...state, relocation: { status: 'rejected', from: FIX, reason: 'earlier' } })
    expect(s.state).toBe('pr_open')
    expect(d.agent.calls).toHaveLength(0)
  })
})
