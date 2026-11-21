import { describe, expect, it } from 'vitest'
import { advanceTicket } from '../../src/core/engine.js'
import { newState, transition } from '../../src/core/states.js'
import { build } from '../../src/core/steps/build.js'
import { checkEnvironment } from '../../src/core/steps/checkEnvironment.js'
import { reproduce } from '../../src/core/steps/reproduce.js'
import { failing, makeDeps, makeRumba, makeTicket, scriptHappyBug } from '../../src/testing/fakes.js'

// Follow-ups from the independent review of the live-run fixes.

describe('a check that could not run while verifying a fix', () => {
  it.each([124, 126, 127])('is an error on exit %i, not a failed fix attempt', async (code) => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'x' }; d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    d.environment.runCheck = async (_h, check) => ({ criterionId: check.criterionId, passed: false, exitCode: code, output: 'Terminated' })
    await expect(build(d, makeRumba(), makeTicket(), failing(d))).rejects.toThrow(new RegExp(`Check for c1 could not run \\(exit ${code}\\): Terminated`))
    expect(d.tracker.states.get('123')).toMatchObject({ state: 'building', fixAttempts: 0 })
    expect(d.environment.downs).toBe(1)
  })
})

describe('a step that fails after the budget ran out', () => {
  it('says what stopped it in the comment, beside the budget', async () => {
    const d = makeDeps(); scriptHappyBug(d)
    let minutes = 0
    d.clock = () => new Date(Date.UTC(2026, 0, 1, 0, minutes))
    const agentRun = d.agent.run.bind(d.agent)
    d.agent.run = async (task, w) => {
      if (task.kind === 'write-checks') { minutes = 31; throw new Error('The agent changed protected paths: .rumba/hub/context.md') }
      return agentRun(task, w)
    }
    const s = await advanceTicket(d, makeRumba(), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('needs_human')
    expect(d.tracker.comments.at(-1)?.body).toBe(
      'Rumba stopped work on this ticket: the time budget of 30 minutes ran out. The last step stopped with: The agent changed protected paths: .rumba/hub/context.md',
    )
  })
})

describe('the environment check, when the project tests cannot run on the default branch', () => {
  it.each([124, 126, 127])('says so on exit %i instead of saying they fail', async (code) => {
    const d = makeDeps(); d.environment.commandExit = code; d.environment.commandOutput = 'Terminated'
    const s = await checkEnvironment(d, makeRumba({ verify: { test: 'pnpm test' } }), makeTicket(), newState('hub', d.clock()))
    expect(s.state).toBe('needs_human'); expect(s.history.at(-1)?.note).toBe('project tests could not run on the default branch')
    const comment = d.tracker.comments.at(-1)!.body
    expect(comment).toMatch(new RegExp(`The project's tests \\(pnpm test\\) could not run on the default branch \\(exit ${code}\\)`))
    expect(comment).toContain('command_timeout_minutes')
    expect(comment).not.toContain('already fail')
  })
})

describe('a ticket whose criteria are all marked not checkable', () => {
  it('says that no criterion can be checked, and lists the reasons', async () => {
    const d = makeDeps()
    const st = {
      ...transition(transition(newState('hub', d.clock()), 'triaged', d.clock()), 'criteria_ready', d.clock()), kind: 'feature' as const,
      criteria: [{ id: 'c1', text: 'Nothing calls the network', checkable: false, reason: 'a constraint on the tests' }],
    }
    const s = await reproduce(d, makeRumba(), makeTicket(), st)
    expect(s.state).toBe('needs_human'); expect(d.agent.calls).toHaveLength(0)
    expect(d.tracker.comments.at(-1)?.body).toBe(
      'No criterion of this ticket can be checked by a command, so Rumba has nothing to verify a change against.\n\n- Nothing calls the network (not checkable: a constraint on the tests)',
    )
  })
})
