import { describe, expect, it } from 'vitest'
import { build } from '../../../src/core/steps/build.js'
import { failing, makeDeps, makeRumba, makeTicket } from '../../../src/testing/fakes.js'

const H = { 'tests/rumba/c1.test.ts': 'h1' }
const fix = { kind: 'fix' as const, summary: 'fixed' }

describe('build', () => {
  it('verifies when the checks pass after the fix', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.passes = () => true
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('verified'); expect(s.after?.[0]!.passed).toBe(true); expect(s.fixAttempts).toBe(0)
    expect(d.environment.ups).toEqual([{ branch: 'rumba/hub/123', sha: 'sha1', role: 'after' }]); expect(d.environment.downs).toBe(1)
    expect(d.workspace.commits).toEqual(['fix: A ticket (#123)'])
    expect(d.agent.calls[0]).toMatchObject({ kind: 'fix', failures: [expect.objectContaining({ criterionId: 'c1' })] })
  })
  it('retries with the failure output, then gives up', async () => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'try' }; d.workspace.hashes = H
    d.environment.passes = () => false
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed'); expect(s.fixAttempts).toBe(2)
    expect(d.agent.calls).toHaveLength(2); expect(d.agent.calls[1]!.failures?.[0]!.criterionId).toBe('c1')
    expect(d.tracker.comments.at(-1)?.body).toMatch(/still fail/)
    expect(d.tracker.comments.at(-1)?.body).toContain('2')
    expect(d.tracker.states.get('123')?.state).toBe('fix_failed')
  })
  it('rejects a fix that edits a check file', async () => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'cheat' }; d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'CHANGED' }
    d.environment.passes = () => true
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed'); expect(d.environment.ups).toHaveLength(0)
    expect(d.workspace.resets).toEqual(['sha1', 'sha1']); expect(d.agent.calls[1]!.failures?.[0]).toMatchObject({ criterionId: 'guard' })
  })
  it('rejects a fix that touches .rumba', async () => {
    const d = makeDeps(); d.agent.script.fix = { kind: 'fix', summary: 'x' }; d.workspace.hashes = H
    d.workspace.changed = ['.rumba/hub/lessons.md']
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed')
    expect(d.agent.calls[1]!.failures?.[0]!.output).toContain('.rumba/hub/lessons.md')
  })
  it('rejects a fix that touches a configured protected path', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.workspace.changed = ['docker-compose.yml']
    const rumba = makeRumba({ environment: { ...makeRumba().environment, protected: ['docker-compose*.y*ml'] } })
    expect((await build(d, rumba, makeTicket(), failing(d))).state).toBe('fix_failed')
    expect(d.environment.ups).toHaveLength(0)
  })
  it('rejects a fix that edits a helper file hashed from the checks commit', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.environment.passes = () => true
    d.workspace.hashes = { ...H, 'tests/rumba/helper.ts': 'EDITED' }
    const st = failing(d); st.checkHashes = { ...H, 'tests/rumba/helper.ts': 'h2' }
    const s = await build(d, makeRumba(), makeTicket(), st)
    expect(s.state).toBe('fix_failed'); expect(d.environment.ups).toHaveLength(0)
    expect(d.agent.calls[1]!.failures?.[0]).toMatchObject({ criterionId: 'guard' })
  })
  it('fails an attempt when the project tests break', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.passes = () => true; d.environment.commandExit = 1
    const s = await build(d, makeRumba({ verify: { test: 'npm test' } }), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed')
    expect(d.agent.calls[1]!.failures?.[0]).toMatchObject({ criterionId: 'project-tests' })
  })
  it('skips the project tests where the environment cannot run commands', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.passes = () => true; d.environment.canRunCommands = false
    expect((await build(d, makeRumba({ verify: { test: 'npm test' } }), makeTicket(), failing(d))).state).toBe('verified')
  })
  it('fails an attempt when the agent changes nothing', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.workspace.commit = async () => null
    const s = await build(d, makeRumba(), makeTicket(), failing(d))
    expect(s.state).toBe('fix_failed'); expect(d.workspace.resets).toEqual([]); expect(d.environment.ups).toHaveLength(0)
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'guard', output: 'The agent changed no files.' }])
  })
  it('removes secrets from stored output, later agent calls and comments', async () => {
    const d = makeDeps(); d.secrets = ['s3cret']; d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.runCheck = async (_h, c) => ({ criterionId: c.criterionId, passed: false, exitCode: 1, output: 'leaked s3cret here' })
    await build(d, makeRumba(), makeTicket(), failing(d))
    expect(JSON.stringify(d.agent.calls[1]!.failures)).not.toContain('s3cret')
    expect(d.tracker.comments.at(-1)?.body).not.toContain('s3cret')
    const ok = makeDeps(); ok.secrets = ['s3cret']; ok.agent.script.fix = fix; ok.workspace.hashes = H
    ok.environment.runCheck = async (_h, c) => ({ criterionId: c.criterionId, passed: true, exitCode: 0, output: 'ok s3cret' })
    const s = await build(ok, makeRumba(), makeTicket(), failing(ok))
    expect(s.state).toBe('verified'); expect(s.after![0]!.output).not.toContain('s3cret')
  })
  it('writes building first and persists fixAttempts after a failed attempt', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => false
    const seen: [string | undefined, number | undefined][] = []
    d.agent.run = async () => { const s = d.tracker.states.get('123'); seen.push([s?.state, s?.fixAttempts]); return fix }
    await build(d, makeRumba(), makeTicket(), failing(d))
    expect(seen).toEqual([['building', 0], ['building', 1]])
  })
  it('takes the environment down even when a check throws', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H
    d.environment.runCheck = async () => { throw new Error('boom') }
    await expect(build(d, makeRumba(), makeTicket(), failing(d))).rejects.toThrow('boom')
    expect(d.environment.downs).toBe(1)
  })
  it('throws on a wrong state or missing branch or checksSha', async () => {
    const d = makeDeps(); const s = failing(d)
    await expect(build(d, makeRumba(), makeTicket(), { ...s, state: 'criteria_ready' })).rejects.toThrow()
    await expect(build(d, makeRumba(), makeTicket(), { ...s, branch: undefined })).rejects.toThrow()
    await expect(build(d, makeRumba(), makeTicket(), { ...s, checksSha: undefined })).rejects.toThrow()
  })
  it('does not mutate the state it is given', async () => {
    const d = makeDeps(); d.agent.script.fix = fix; d.workspace.hashes = H; d.environment.passes = () => false
    const start = failing(d); const copy = structuredClone(start)
    await build(d, makeRumba(), makeTicket(), start)
    expect(start).toEqual(copy)
  })
})
