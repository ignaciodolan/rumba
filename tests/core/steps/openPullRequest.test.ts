import { describe, expect, it } from 'vitest'
import { openPullRequest } from '../../../src/core/steps/openPullRequest.js'
import { failing, makeDeps, makeRumba, makeTicket, verified } from '../../../src/testing/fakes.js'

describe('openPullRequest', () => {
  it('pushes, opens a draft when something is unverified, and links it on the ticket', async () => {
    const d = makeDeps(); const s = await openPullRequest(d, makeRumba(), makeTicket({ title: 'Profile 500', ref: '#123' }), verified(d))
    expect(s.state).toBe('pr_open'); expect(s.pullRequestUrl).toBe('https://example.test/pr/1')
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/shop/123', force: true }])
    expect(d.codeHost.prs[0]).toMatchObject({ title: 'Profile 500 (#123)', head: 'rumba/shop/123', base: 'main', draft: true })
    expect(d.tracker.comments.at(-1)?.body).toContain('https://example.test/pr/1')
    expect(d.tracker.states.get('123')?.state).toBe('pr_open')
  })
  it('opens a ready pull request when every criterion is verified', async () => {
    const d = makeDeps(); const v = verified(d); v.criteria = v.criteria.filter((c) => c.checkable)
    await openPullRequest(d, makeRumba(), makeTicket(), v)
    expect(d.codeHost.prs[0]!.draft).toBe(false)
  })
  it('lists changed files outside the rumba paths in the body', async () => {
    const d = makeDeps(); d.workspace.changed = ['src/a.ts', 'packages/ui/y.ts']
    await openPullRequest(d, makeRumba({ paths: ['src/**'] }), makeTicket(), verified(d))
    expect(d.codeHost.prs[0]!.body).toMatch(/## Outside this rumba's scope[\s\S]*packages\/ui\/y\.ts/)
  })
  it('lists an undeclared file from the checks commit that is outside the paths', async () => {
    const d = makeDeps(); d.workspace.changed = ['apps/shop/x.ts', 'packages/ui/helper.ts', 'tests/rumba/c1.test.ts']
    const v = verified(d); v.checkHashes = { ...v.checkHashes, 'packages/ui/helper.ts': 'h2' }
    await openPullRequest(d, makeRumba({ paths: ['apps/shop/**'] }), makeTicket(), v)
    const body = d.codeHost.prs[0]!.body
    expect(body).toMatch(/## Outside this rumba's scope[\s\S]*packages\/ui\/helper\.ts/)
    expect(body.split("## Outside this rumba's scope")[1]).not.toContain('tests/rumba/c1.test.ts')
  })
  it('records the state before commenting, so a failed comment cannot lead to a second pull request', async () => {
    const d = makeDeps(); d.tracker.comment = async () => { throw new Error('comment failed') }
    await expect(openPullRequest(d, makeRumba(), makeTicket(), verified(d))).rejects.toThrow('comment failed')
    expect(d.tracker.states.get('123')?.state).toBe('pr_open')
    expect(d.codeHost.prs).toHaveLength(1)
  })
  it('throws when the state is not verified', async () => {
    const d = makeDeps()
    await expect(openPullRequest(d, makeRumba(), makeTicket(), failing(d))).rejects.toThrow(/checks_failing/)
  })
  it('throws without a branch or base commit', async () => {
    const d = makeDeps(); const v = verified(d); delete v.baseSha
    await expect(openPullRequest(d, makeRumba(), makeTicket(), v)).rejects.toThrow()
  })
  it('does not change the state it is given', async () => {
    const d = makeDeps(); const v = verified(d); const copy = structuredClone(v)
    await openPullRequest(d, makeRumba(), makeTicket(), v)
    expect(v).toEqual(copy)
  })
})
