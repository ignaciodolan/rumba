import { describe, expect, it } from 'vitest'
import { newState, transition } from '../../../src/core/states.js'
import { reproduce } from '../../../src/core/steps/reproduce.js'
import { AgentError } from '../../../src/ports/agent.js'
import { makeDeps, makeRumba, makeTicket } from '../../../src/testing/fakes.js'

const ready = (d: ReturnType<typeof makeDeps>, kind: 'bug' | 'feature', n = 1) => ({
  ...transition(transition(newState('hub', d.clock()), 'triaged', d.clock()), 'criteria_ready', d.clock()), kind,
  criteria: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `C${i + 1}`, checkable: true })) })
const checksFor = (n: number) => ({ kind: 'write-checks' as const,
  checks: Array.from({ length: n }, (_, i) => ({ criterionId: `c${i + 1}`, command: `npm test -- c${i + 1}`, files: [`tests/rumba/c${i + 1}.test.ts`] })) })

/** Adds hashing and the environment's up and down to the workspace's call log. */
function trace(d: ReturnType<typeof makeDeps>): void {
  const { workspace: ws, environment: env } = d
  const hash = ws.hashFiles.bind(ws); const up = env.up.bind(env); const down = env.down.bind(env)
  ws.hashFiles = async (w, f) => { ws.log.push(`hash ${w}`); return hash(w, f) }
  env.up = async (r, w) => { ws.log.push(`up ${w}`); return up(r, w) }
  env.down = async (h) => { ws.log.push(`down ${h.workdir}`); return down(h) }
}

describe('reproduce', () => {
  it('reaches checks_failing when every check fails on the base', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    const s = await reproduce(d, makeRumba(), makeTicket({ id: '123' }), ready(d, 'bug'))
    expect(s.state).toBe('checks_failing')
    expect(s.branch).toBe('rumba/hub/123'); expect(s.baseSha).toBe('base000'); expect(s.checksSha).toBe('sha1')
    expect(s.before).toEqual([expect.objectContaining({ criterionId: 'c1', passed: false })])
    expect(s.checkHashes).toEqual({ 'tests/rumba/c1.test.ts': 'h1' })
    expect(d.environment.ups).toEqual([{ branch: 'rumba/hub/123', sha: 'sha1', role: 'before' }]); expect(d.environment.downs).toBe(1)
  })
  it('marks a bug not_reproducible when its check passes', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.environment.passes = () => true
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.state).toBe('not_reproducible'); expect(d.tracker.comments.at(-1)?.body).toMatch(/could not reproduce/)
  })
  it('sends a feature to needs_human when a check already passes', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(2); d.environment.passes = c => c.criterionId === 'c2'
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'feature', 2))
    expect(s.state).toBe('needs_human'); expect(d.tracker.comments.at(-1)?.body).toContain('C2')
  })
  it('needs a human when nothing can be checked', async () => {
    const d = makeDeps(); const st = ready(d, 'feature'); st.criteria[0]!.checkable = false
    const s = await reproduce(d, makeRumba(), makeTicket(), st)
    expect(s.state).toBe('needs_human'); expect(d.agent.calls).toHaveLength(0)
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba could not write a check for any criterion.')
  })
  it('takes the environment down even when a check throws', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.environment.runCheck = async () => { throw new Error('boom') }
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow('boom')
    expect(d.environment.downs).toBe(1)
  })
  it('passes the checkable criteria and context to the agent', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    const st = ready(d, 'feature', 2); st.criteria[1]!.checkable = false
    await reproduce(d, makeRumba({ context: 'Hub notes' }), makeTicket(), st)
    expect(d.agent.calls[0]).toMatchObject({ kind: 'write-checks', context: 'Hub notes', environmentKind: 'docker', criteria: [st.criteria[0]] })
  })
  it('drops checks for unknown criteria and needs a human if none are left', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = { kind: 'write-checks', checks: [{ criterionId: 'zzz', command: 'x', files: [] }] }
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toHaveLength(0)
    expect(d.tracker.comments.at(-1)?.body).toBe('Rumba could not write a check for any criterion.')
  })
  it('throws when the workspace makes no checks commit', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.workspace.commit = async () => null
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow(/checks commit/)
    expect(d.environment.ups).toEqual([])
  })
  it('runs the environment in a new checkout, prepared after the agent worktree was cleaned up', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); trace(d)
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.state).toBe('checks_failing')
    const [agentDir] = d.agent.workdirs; const [envDir] = d.environment.upWorkdirs
    expect(envDir).not.toBe(agentDir)
    expect(d.workspace.log).toEqual([
      `prepare rumba/hub/123 fresh ${agentDir}`,
      `commit ${agentDir} allowEmpty`,
      `cleanup ${agentDir}`,
      `prepare rumba/hub/123 existing ${envDir}`,
      `hash ${envDir}`,
      `up ${envDir}`,
      `down ${envDir}`,
      `cleanup ${envDir}`,
    ])
  })
  it('cleans up the agent worktree and prepares no environment when a protected path changed', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.changed = ['.env']; trace(d)
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow(/\.env/)
    const [agentDir] = d.agent.workdirs
    expect(d.workspace.log).toEqual([`prepare rumba/hub/123 fresh ${agentDir}`, `commit ${agentDir} allowEmpty`, `cleanup ${agentDir}`])
  })
  it('returns its state when a cleanup fails', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.workspace.cleanup = async () => { throw new Error('cannot delete') }
    expect((await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).state).toBe('checks_failing')
    d.environment.up = async () => { throw new Error('no env') }
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow('no env')
  })
  it('writes env_ready before running the checks', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    let seen: string | undefined
    d.environment.runCheck = async (_h, c) => { seen = d.tracker.states.get('123')?.state; return { criterionId: c.criterionId, passed: false, exitCode: 1, output: '' } }
    await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(seen).toBe('env_ready')
  })
  it('propagates an environment.up failure', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    d.environment.up = async () => { throw new Error('no env') }
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow('no env')
    expect(d.environment.downs).toBe(0)
  })
  it('removes secrets from stored output', async () => {
    const d = makeDeps(); d.secrets = ['s3cret']; d.agent.script['write-checks'] = checksFor(1)
    d.environment.runCheck = async (_h, c) => ({ criterionId: c.criterionId, passed: false, exitCode: 1, output: 'leaked s3cret here' })
    const s = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(s.before![0]!.output).not.toContain('s3cret')
    expect(d.tracker.states.get('123')?.before![0]!.output).not.toContain('s3cret')
  })
  it('rejects checks that touched a protected path before running them', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.changed = ['.rumba/hub/context.md']
    await expect(reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))).rejects.toThrow(/\.rumba\/hub\/context\.md/)
    expect(d.environment.ups).toEqual([])
  })
  it('hashes declared check files and every file from the checks commit', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1); d.workspace.changed = ['tests/rumba/helper.ts']
    const asked: string[][] = []
    d.workspace.hashFiles = async (_w, files) => { asked.push(files); return Object.fromEntries(files.map((f) => [f, 'h'])) }
    await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug'))
    expect(asked[0]).toEqual(expect.arrayContaining(['tests/rumba/c1.test.ts', 'tests/rumba/helper.ts']))
  })
  it('throws on a state that is not criteria_ready', async () => {
    const d = makeDeps()
    await expect(reproduce(d, makeRumba(), makeTicket(), newState('hub', d.clock()))).rejects.toThrow()
  })
  it('does not mutate the state it is given', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(1)
    const start = ready(d, 'bug'); const copy = structuredClone(start)
    await reproduce(d, makeRumba(), makeTicket(), start)
    expect(start).toEqual(copy)
  })
  it.each([124, 126, 127])('throws after taking the environment down when a check could not run (exit %i)', async (code) => {
    const d = makeDeps(); d.secrets = ['s3cret']; d.agent.script['write-checks'] = checksFor(2)
    d.environment.runCheck = async (_h, c) => c.criterionId === 'c2'
      ? { criterionId: 'c2', passed: false, exitCode: code, output: 'sh: s3cret-tool: not found' }
      : { criterionId: 'c1', passed: false, exitCode: 1, output: 'assertion failed' }
    const err = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug', 2)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe(`Check for c2 could not run (exit ${code}): sh: [redacted]-tool: not found`)
    expect(d.environment.downs).toBe(1)
    expect(d.tracker.states.get('123')?.state).toBe('env_ready')
  })
  it('rejects a declared check file missing from the clean checkout, before up', async () => {
    const d = makeDeps(); d.agent.script['write-checks'] = checksFor(2); trace(d)
    d.workspace.hashes = { 'tests/rumba/c1.test.ts': 'h1' }
    const err = await reproduce(d, makeRumba(), makeTicket(), ready(d, 'bug', 2)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AgentError)
    expect((err as Error).message).toBe('The check file tests/rumba/c2.test.ts was not committed; is it ignored by git?')
    expect(d.environment.ups).toEqual([])
    const [envDir] = d.workspace.log.filter((l) => l.startsWith('hash ')).map((l) => l.slice(5))
    expect(d.workspace.log.slice(-3)).toEqual([`prepare rumba/hub/123 existing ${envDir}`, `hash ${envDir}`, `cleanup ${envDir}`])
  })
})

