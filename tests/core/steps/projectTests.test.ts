import { describe, expect, it } from 'vitest'
import { build } from '../../../src/core/steps/build.js'
import { failing, makeDeps, makeRumba, makeTicket } from '../../../src/testing/fakes.js'

// verify.test that timed out (124), could not execute (126) or was not found (127) says
// nothing about the fix. Like a check that could not run, it is an error, not a failed attempt.

describe('build: the project tests could not run', () => {
  it.each([124, 126, 127])('throws on exit %i and counts no fix attempt', async (code) => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'x' }; d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    d.environment.passes = () => true; d.environment.commandExit = code; d.environment.commandOutput = 'pnpm: not found'
    await expect(build(d, makeRumba({ verify: { test: 'pnpm test' } }), makeTicket(), failing(d)))
      .rejects.toThrow(new RegExp(`project tests could not run \\(exit ${code}\\): pnpm: not found`))
    expect(d.tracker.states.get('123')).toMatchObject({ state: 'building', fixAttempts: 0 })
    expect(d.environment.downs).toBe(1)
  })
  it('still counts a plain failure of the project tests against the fix', async () => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'x' }; d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    d.environment.passes = () => true; d.environment.commandExit = 1
    const s = await build(d, makeRumba({ verify: { test: 'pnpm test' } }), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed')
  })
})
