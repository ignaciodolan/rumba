import { describe, expect, it } from 'vitest'
import { newState, transition } from '../../src/core/states.js'
import { FakeCodeHost, FakeWorkspace, makeDeps, makeTicket } from '../../src/testing/fakes.js'

describe('fakes', () => {
  it('FakeAgent plays a script and records calls', async () => {
    const d = makeDeps()
    d.agent.script.fix = [{ kind: 'fix', summary: 'one' }, { kind: 'fix', summary: 'two' }]
    const task = { kind: 'fix' as const, ticket: makeTicket(), context: '', environmentKind: 'docker' as const }
    expect(await d.agent.run(task, '/w')).toEqual({ kind: 'fix', summary: 'one' })
    expect(await d.agent.run(task, '/w')).toEqual({ kind: 'fix', summary: 'two' })
    expect(await d.agent.run(task, '/w')).toEqual({ kind: 'fix', summary: 'two' })
    expect(d.agent.calls).toHaveLength(3)
  })

  it('FakeTracker keeps exactly one state label', async () => {
    const d = makeDeps()
    const t = makeTicket({ labels: ['rumba:shop'] })
    d.tracker.tickets.push(t)
    await d.tracker.writeState(t, newState('shop', d.clock()))
    await d.tracker.writeState(t, transition(newState('shop', d.clock()), 'triaged', d.clock()))
    expect(t.labels.filter((l) => l.startsWith('rumba-state:'))).toEqual(['rumba-state:triaged'])
  })

  it('FakeEnvironment fails before and passes after by default', async () => {
    const d = makeDeps()
    const c = { criterionId: 'c1', command: 'x', files: [] }
    const a = await d.environment.up({ branch: 'b', sha: '1', role: 'before' }, '/w')
    expect((await d.environment.runCheck(a, c)).passed).toBe(false)
    const b = await d.environment.up({ branch: 'b', sha: '2', role: 'after' }, '/w')
    expect((await d.environment.runCheck(b, c)).passed).toBe(true)
  })

  it('FakeAgent throws a named error when no script exists and throws Error items', async () => {
    const d = makeDeps()
    const task = { kind: 'triage' as const, ticket: makeTicket(), context: '', environmentKind: 'docker' as const }
    await expect(d.agent.run(task, '/w')).rejects.toThrow('triage')
    d.agent.script.triage = new Error('boom')
    await expect(d.agent.run(task, '/w')).rejects.toThrow('boom')
  })

  it('FakeTracker lists open opted-in candidates, stores copies, and dedupes commentOnce', async () => {
    const d = makeDeps()
    const a = makeTicket({ id: '1' })
    const b = makeTicket({ id: '2' })
    const c = makeTicket({ id: '3', labels: [] })
    d.tracker.tickets.push(a, b, c)
    d.tracker.closed.add('2')
    expect((await d.tracker.listCandidates()).map((t) => t.id)).toEqual(['1'])
    await expect(d.tracker.getTicket('nope')).rejects.toThrow()
    expect(await d.tracker.readState(a)).toBeNull()
    const s = newState('shop', d.clock())
    await d.tracker.writeState(a, s)
    const read = await d.tracker.readState(a)
    expect(read).toEqual(s)
    expect(read).not.toBe(d.tracker.states.get('1'))
    await d.tracker.commentOnce(a, 'k', 'x')
    await d.tracker.commentOnce(a, 'k', 'y')
    expect(d.tracker.comments).toEqual([{ ticketId: '1', body: 'x' }])
  })
})

describe('FakeCodeHost.getPullRequest', () => {
  it('reports a pull request it opened as open', async () => {
    const host = new FakeCodeHost()
    const url = await host.openPullRequest({ title: 'T', body: 'B', head: 'h', base: 'main', draft: true })
    expect(await host.getPullRequest(url)).toEqual({ state: 'open', headSha: 'head0', labels: [] })
  })

  it('returns what the test set for a URL', async () => {
    const host = new FakeCodeHost()
    host.pullRequests.set('https://example.test/pr/9', { state: 'merged', headSha: 'x', mergedAt: '2026-01-01T00:00:00Z' })
    expect(await host.getPullRequest('https://example.test/pr/9')).toMatchObject({ state: 'merged' })
  })

  it('returns the labels of a pull request, and none by default', async () => {
    const host = new FakeCodeHost()
    host.pullRequests.set('https://example.test/pr/9', { state: 'open', headSha: 'x', labels: ['revise'] })
    expect((await host.getPullRequest('https://example.test/pr/9')).labels).toEqual(['revise'])
  })

  it('lists feedback after since and records removed labels', async () => {
    const host = new FakeCodeHost()
    const item = (at: string) => ({ kind: 'comment' as const, author: 'alice', url: 'u', at, text: 't', canWrite: true, self: false })
    host.feedback.set('https://example.test/pr/9', [item('2026-01-01T00:00:00Z'), item('2026-01-02T00:00:00Z')])
    expect(await host.listFeedback('https://example.test/pr/9', '2026-01-01T00:00:00Z')).toEqual([item('2026-01-02T00:00:00Z')])
    await host.removeLabel('https://example.test/pr/9', 'revise')
    expect(host.labelsRemoved).toEqual([{ url: 'https://example.test/pr/9', label: 'revise' }])
  })

  it('records pull request updates and comments, and returns the configured diff', async () => {
    const host = new FakeCodeHost()
    await host.updatePullRequest('https://example.test/pr/9', { body: 'new' })
    await host.commentOnPullRequest('https://example.test/pr/9', 'done')
    expect(host.updates).toEqual([{ url: 'https://example.test/pr/9', body: 'new' }])
    expect(host.pullRequestComments).toEqual([{ url: 'https://example.test/pr/9', body: 'done' }])
    const ws = new FakeWorkspace(); ws.diffText = 'diff --git a b'
    expect(await ws.diff('/w', 'sha', 100)).toBe('diff --git a b')
  })

  it('FakeWorkspace records commitFile and moves the branch to the sha it returns', async () => {
    const ws = new FakeWorkspace()
    const { workdir } = await ws.prepare('rumba/shop/123', { fresh: false })
    const sha = await ws.commitFile(workdir, '.rumba/shop/lessons.md', '- Orders ship in one box.\n', 'docs: add a lesson')
    expect(ws.fileCommits).toEqual([{ workdir, path: '.rumba/shop/lessons.md', content: '- Orders ship in one box.\n', message: 'docs: add a lesson' }])
    expect(await ws.head(workdir)).toBe(sha)
    expect(sha).not.toBe(await ws.commitFile(workdir, '.rumba/shop/lessons.md', 'again', 'docs: another'))
  })

  it('throws for an unknown URL and when told to', async () => {
    const host = new FakeCodeHost()
    await expect(host.getPullRequest('https://example.test/pr/5')).rejects.toThrow()
    const url = await host.openPullRequest({ title: 'T', body: 'B', head: 'h', base: 'main', draft: true })
    host.pullRequestError = new Error('boom')
    await expect(host.getPullRequest(url)).rejects.toThrow('boom')
  })
})
