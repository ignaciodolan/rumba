import { describe, expect, it } from 'vitest'
import { HttpVercelClient, VercelPreviewEnvironment } from '../../../src/adapters/environment/vercelPreview.js'
import { makeDeps } from '../../../src/testing/fakes.js'

const mk = (states: any[], over = {}) => {
  const d = makeDeps(); let i = 0; const sandboxCalls: any[] = []
  const env = new VercelPreviewEnvironment({ codeHost: d.codeHost, sleep: async () => {}, pollMs: 1, timeoutMs: 50,
    client: { findDeployment: async () => states[Math.min(i++, states.length - 1)] },
    sandbox: { run: async o => { sandboxCalls.push(o); return { exitCode: 0, output: 'ok' } } }, ...over })
  return { env, d, sandboxCalls }
}

describe('VercelPreviewEnvironment', () => {
  it('pushes a throwaway base branch, waits for READY and returns the URL', async () => {
    const { env, d } = mk([null, { state: 'BUILDING', url: 'x.vercel.app', target: 'preview' }, { state: 'READY', url: 'x.vercel.app', target: 'preview' }])
    const h = await env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'before' }, '/w')
    expect(h.baseUrl).toBe('https://x.vercel.app'); expect(d.codeHost.pushed[0].branch).toBe('rumba/hub/base-123')
    await env.down(h); expect(d.codeHost.deleted).toEqual(['rumba/hub/base-123'])
  })
  it('pushes the fix branch itself for the after-run and deletes nothing', async () => {
    const { env, d } = mk([{ state: 'READY', url: 'y.vercel.app', target: 'preview' }])
    const h = await env.up({ branch: 'rumba/hub/123', sha: 'def', role: 'after' }, '/w')
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/hub/123', force: true }]); await env.down(h); expect(d.codeHost.deleted).toEqual([])
  })
  it('refuses a production deployment', async () => {
    const { env } = mk([{ state: 'READY', url: 'app.com', target: 'production' }])
    await expect(env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'after' }, '/w')).rejects.toThrow(/production/)
  })
  it('fails on a broken deployment and on timeout', async () => {
    await expect(mk([{ state: 'ERROR', url: 'x', target: 'preview' }]).env.up({ branch: 'b', sha: 's', role: 'before' }, '/w')).rejects.toThrow(/ERROR/)
    await expect(mk([null]).env.up({ branch: 'b', sha: 's', role: 'before' }, '/w')).rejects.toThrow(/did not become ready/)
  })
  it('runs checks in the sandbox with the URL and bypass secret only', async () => {
    const { env, sandboxCalls } = mk([{ state: 'READY', url: 'x.vercel.app', target: 'preview' }], { bypassSecret: 'byp' })
    const h = await env.up({ branch: 'b', sha: 's', role: 'before' }, '/w'); await env.runCheck(h, { criterionId: 'c1', command: 'node check.mjs', files: [] })
    expect(sandboxCalls[0].env).toEqual({ RUMBA_BASE_URL: 'https://x.vercel.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'byp' })
  })
  it('cannot run project commands', async () => {
    expect(await mk([]).env.runCommand({ workdir: '/w' }, 'npm test')).toBeNull()
  })

  it('force-pushes the throwaway base branch', async () => {
    const { env, d } = mk([{ state: 'READY', url: 'x.vercel.app', target: null }])
    await env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'before' }, '/w')
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/hub/base-123', force: true }])
  })
  it('accepts a deployment whose target is null', async () => {
    const { env } = mk([{ state: 'READY', url: 'x.vercel.app', target: null }])
    expect(await env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')).toEqual({ workdir: '/w', baseUrl: 'https://x.vercel.app' })
  })
  it('fails on a canceled deployment', async () => {
    await expect(mk([{ state: 'CANCELED', url: 'x.vercel.app', target: 'preview' }]).env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')).rejects.toThrow(/CANCELED/)
  })
  it('refuses production even while it is still building', async () => {
    const { env } = mk([{ state: 'BUILDING', url: 'app.com', target: 'production' }])
    await expect(env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')).rejects.toThrow('Refusing to run checks against a production deployment.')
  })
  it('measures the timeout in poll time', async () => {
    let calls = 0; const slept: number[] = []
    const env = new VercelPreviewEnvironment({ codeHost: makeDeps().codeHost, sandbox: { run: async () => ({ exitCode: 0, output: '' }) },
      pollMs: 10, timeoutMs: 35, sleep: async ms => { slept.push(ms) }, client: { findDeployment: async () => { calls++; return null } } })
    await expect(env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')).rejects.toThrow(/did not become ready/)
    expect(slept.every(ms => ms === 10)).toBe(true); expect(calls).toBe(4)
  })
  it('accepts only a bare host name as the deployment URL', async () => {
    for (const url of ['https://x.vercel.app', 'x.vercel.app/path', 'user@x.vercel.app', 'x.vercel.app:8080', '', 'x vercel.app']) {
      await expect(mk([{ state: 'READY', url, target: 'preview' }]).env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')).rejects.toThrow(/host name/)
    }
    const h = await mk([{ state: 'READY', url: 'my-app-git-fix-1-team.vercel.app', target: 'preview' }]).env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')
    expect(h.baseUrl).toBe('https://my-app-git-fix-1-team.vercel.app')
  })
  it('deletes the throwaway base branch when up fails after pushing it', async () => {
    const failures: any[][] = [
      [{ state: 'ERROR', url: 'x.vercel.app', target: 'preview' }],
      [{ state: 'CANCELED', url: 'x.vercel.app', target: 'preview' }],
      [null],
      [{ state: 'READY', url: 'app.com', target: 'production' }],
      [{ state: 'READY', url: 'https://evil.test', target: 'preview' }],
    ]
    for (const states of failures) {
      const { env, d } = mk(states)
      await expect(env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'before' }, '/w')).rejects.toThrow()
      expect(d.codeHost.deleted).toEqual(['rumba/hub/base-123'])
    }
  })
  it('rethrows the original error when deleting the branch also fails', async () => {
    const { env, d } = mk([{ state: 'ERROR', url: 'x.vercel.app', target: 'preview' }])
    d.codeHost.deleteBranch = async () => { throw new Error('delete failed') }
    await expect(env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'before' }, '/w')).rejects.toThrow(/ERROR/)
  })
  it('deletes nothing when an after-run up fails', async () => {
    const { env, d } = mk([{ state: 'ERROR', url: 'x.vercel.app', target: 'preview' }])
    await expect(env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'after' }, '/w')).rejects.toThrow()
    expect(d.codeHost.deleted).toEqual([])
  })
  it('deletes nothing for an unknown handle, deletes once, and never throws from down', async () => {
    const { env, d } = mk([{ state: 'READY', url: 'x.vercel.app', target: 'preview' }])
    await env.down({ workdir: '/w', baseUrl: 'https://x.vercel.app' }); expect(d.codeHost.deleted).toEqual([])
    const h = await env.up({ branch: 'rumba/hub/123', sha: 'abc', role: 'before' }, '/w')
    d.codeHost.deleteBranch = async () => { throw new Error('delete failed') }
    await expect(env.down(h)).resolves.toBeUndefined()
  })
  it('runs the check command through sh in the workdir and reports its result', async () => {
    const calls: any[] = []
    const { env } = mk([{ state: 'READY', url: 'x.vercel.app', target: 'preview' }], {
      checkTimeoutMs: 1234, sandbox: { run: async (o: any) => { calls.push(o); return { exitCode: 3, output: ' raw output\n' } } },
    })
    const h = await env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')
    expect(await env.runCheck(h, { criterionId: 'c1', command: 'node check.cjs', files: [] }))
      .toEqual({ criterionId: 'c1', passed: false, exitCode: 3, output: ' raw output\n' })
    expect(calls).toEqual([{ workdir: '/w', command: ['sh', '-c', 'node check.cjs'], env: { RUMBA_BASE_URL: 'https://x.vercel.app' }, timeoutMs: 1234 }])
  })
  it('passes a check that exits 0 and uses a ten minute check timeout by default', async () => {
    const { env, sandboxCalls } = mk([{ state: 'READY', url: 'x.vercel.app', target: 'preview' }])
    const h = await env.up({ branch: 'b', sha: 's', role: 'after' }, '/w')
    expect((await env.runCheck(h, { criterionId: 'c1', command: 'true', files: [] })).passed).toBe(true)
    expect(sandboxCalls[0].timeoutMs).toBe(600000)
  })
})

type Call = { url: string; init: RequestInit | undefined }
const stubFetch = (status: number, body: unknown) => {
  const calls: Call[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}
const dep = (over: Record<string, unknown> = {}) => ({ uid: 'dpl_1', url: 'x.vercel.app', readyState: 'READY', state: 'READY', target: null, created: 1, createdAt: 1, ...over })

describe('HttpVercelClient', () => {
  it('lists deployments of the project by SHA with a bearer token', async () => {
    const { fetch, calls } = stubFetch(200, { deployments: [dep()], pagination: {} })
    const c = new HttpVercelClient({ token: 'tok-secret', projectId: 'prj_1', fetch })
    expect(await c.findDeployment({ sha: 'abc123' })).toEqual({ state: 'READY', url: 'x.vercel.app', target: null })
    const u = new URL(calls[0]!.url)
    expect(u.origin + u.pathname).toBe('https://api.vercel.com/v7/deployments')
    expect(u.searchParams.get('projectId')).toBe('prj_1'); expect(u.searchParams.get('sha')).toBe('abc123')
    expect(u.searchParams.has('teamId')).toBe(false)
    expect(new Headers(calls[0]!.init?.headers).get('authorization')).toBe('Bearer tok-secret')
    expect(calls[0]!.url).not.toContain('tok-secret')
  })
  it('passes the team id only when one is given', async () => {
    const { fetch, calls } = stubFetch(200, { deployments: [], pagination: {} })
    await new HttpVercelClient({ token: 't', projectId: 'p', teamId: 'team_1', fetch }).findDeployment({ sha: 's' })
    expect(new URL(calls[0]!.url).searchParams.get('teamId')).toBe('team_1')
  })
  it('returns null when no deployment matches', async () => {
    const { fetch } = stubFetch(200, { deployments: [], pagination: {} })
    expect(await new HttpVercelClient({ token: 't', projectId: 'p', fetch }).findDeployment({ sha: 's' })).toBeNull()
  })
  it('picks the newest deployment when several match', async () => {
    const { fetch } = stubFetch(200, { deployments: [
      dep({ url: 'old.vercel.app', created: 100, readyState: 'ERROR' }),
      dep({ url: 'new.vercel.app', created: 300, readyState: 'BUILDING' }),
      dep({ url: 'mid.vercel.app', created: 200 }),
    ] })
    expect(await new HttpVercelClient({ token: 't', projectId: 'p', fetch }).findDeployment({ sha: 's' }))
      .toEqual({ state: 'BUILDING', url: 'new.vercel.app', target: null })
  })
  it('maps every documented state onto the five the environment knows', async () => {
    const expected: Record<string, string> = {
      QUEUED: 'QUEUED', INITIALIZING: 'QUEUED', BUILDING: 'BUILDING', READY: 'READY',
      ERROR: 'ERROR', BLOCKED: 'ERROR', CANCELED: 'CANCELED', DELETED: 'CANCELED',
    }
    for (const [state, mapped] of Object.entries(expected)) {
      const { fetch } = stubFetch(200, { deployments: [dep({ readyState: state, state })] })
      expect((await new HttpVercelClient({ token: 't', projectId: 'p', fetch }).findDeployment({ sha: 's' }))?.state).toBe(mapped)
    }
  })
  it('maps the target, treating anything that has served production as production', async () => {
    const cases: [Record<string, unknown>, string | null][] = [
      [{ target: 'production' }, 'production'],
      [{ target: null }, null],
      [{ target: undefined }, null],
      [{ target: 'preview' }, 'preview'],
      [{ target: 'staging' }, null],
      [{ target: 'something-new' }, 'production'],
      [{ target: null, readySubstate: 'PROMOTED' }, 'production'],
      [{ target: null, readySubstate: 'ROLLING' }, 'production'],
      [{ target: null, readySubstate: 'STAGED' }, null],
    ]
    for (const [over, target] of cases) {
      const { fetch } = stubFetch(200, { deployments: [dep(over)] })
      expect((await new HttpVercelClient({ token: 't', projectId: 'p', fetch }).findDeployment({ sha: 's' }))?.target).toBe(target)
    }
  })
  it('throws with the status, without the token, on a non-2xx response', async () => {
    const { fetch } = stubFetch(403, { error: { message: 'forbidden' } })
    const err = await new HttpVercelClient({ token: 'tok-secret', projectId: 'p', fetch }).findDeployment({ sha: 's' }).catch(e => e)
    expect(err).toBeInstanceOf(Error); expect(err.message).toContain('403'); expect(err.message).not.toContain('tok-secret')
  })
  it('throws on an unknown state or a malformed response', async () => {
    const unknown = stubFetch(200, { deployments: [dep({ readyState: 'EXPLODED', state: 'EXPLODED' })] })
    await expect(new HttpVercelClient({ token: 't', projectId: 'p', fetch: unknown.fetch }).findDeployment({ sha: 's' })).rejects.toThrow(/EXPLODED/)
    const bad = stubFetch(200, { nope: true })
    await expect(new HttpVercelClient({ token: 't', projectId: 'p', fetch: bad.fetch }).findDeployment({ sha: 's' })).rejects.toThrow()
  })
  it('reports a deployment without a URL yet with an empty URL', async () => {
    const { fetch } = stubFetch(200, { deployments: [dep({ url: null, readyState: 'QUEUED' })] })
    expect(await new HttpVercelClient({ token: 't', projectId: 'p', fetch }).findDeployment({ sha: 's' })).toEqual({ state: 'QUEUED', url: '', target: null })
  })
})
