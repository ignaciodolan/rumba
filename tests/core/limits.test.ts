import { describe, expect, it } from 'vitest'
import { encodeStateComment } from '../../src/core/stateComment.js'
import { newState, transition } from '../../src/core/states.js'
import { build } from '../../src/core/steps/build.js'
import { openPullRequest } from '../../src/core/steps/openPullRequest.js'
import { reproduce } from '../../src/core/steps/reproduce.js'
import { makeDeps, makeRumba, makeTicket } from '../../src/testing/fakes.js'

// GitHub refuses a comment or a pull request body over 65,536 characters.
describe('stored output', () => {
  it('fits a tracker comment and a pull request body with 20 checks of 10,000 characters each', async () => {
    const d = makeDeps(); const n = 20
    const criteria = Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `Criterion ${i + 1} `.padEnd(500, 'x'), checkable: true }))
    const checks = criteria.map((c) => ({ criterionId: c.id, command: `npm test -- tests/rumba/${c.id}.test.ts`, files: [`tests/rumba/${c.id}.test.ts`] }))
    d.agent.script['write-checks'] = { kind: 'write-checks', checks }
    d.agent.script.fix = { kind: 'fix', summary: 'fixed' }
    d.workspace.hashes = Object.fromEntries(checks.map((c) => [c.files[0]!, 'h']))
    d.environment.runCheck = async (h, c) => {
      const passed = d.environment.upWorkdirs.length > 1
      return { criterionId: c.criterionId, passed, exitCode: passed ? 0 : 1, output: `${h.workdir} `.padEnd(10_000, passed ? 'p' : 'f') }
    }
    const ready = { ...transition(transition(newState('shop', d.clock()), 'triaged', d.clock()), 'criteria_ready', d.clock()), kind: 'feature' as const, criteria }
    const ticket = makeTicket()
    const failing = await reproduce(d, makeRumba(), ticket, ready)
    expect(failing.state).toBe('checks_failing')
    const verified = await build(d, makeRumba(), ticket, failing)
    expect(verified.state).toBe('verified')
    const open = await openPullRequest(d, makeRumba(), ticket, verified)
    for (const s of [failing, verified, open]) expect(encodeStateComment(s).length).toBeLessThan(60_000)
    expect(d.codeHost.prs[0]!.body.length).toBeLessThan(60_000)
  })
})
