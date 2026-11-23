import { describe, expect, it } from 'vitest'
import { trackPullRequest } from '../../../src/core/steps/trackPullRequest.js'
import { makeDeps, makeRumba, makeTicket, verified } from '../../../src/testing/fakes.js'
import { transition } from '../../../src/core/states.js'

const URL = 'https://example.test/pr/42'

function prOpen(d: ReturnType<typeof makeDeps>) {
  return { ...transition(verified(d), 'pr_open', d.clock()), pullRequestUrl: URL }
}

describe('trackPullRequest', () => {
  it('moves to merged, records when, and comments', async () => {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'merged', headSha: 'h', mergedAt: '2026-11-20T10:00:00Z' })
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), prOpen(d))
    expect(s.state).toBe('merged')
    expect(s.history.at(-1)?.note).toBe('merged at 2026-11-20T10:00:00Z')
    expect(d.tracker.states.get('123')?.state).toBe('merged')
    expect(d.tracker.comments.at(-1)?.body).toBe(`The pull request was merged: ${URL}`)
  })
  it('moves to merged without a time when none is given', async () => {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'merged', headSha: 'h' })
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), prOpen(d))
    expect(s.history.at(-1)?.note).toBe('merged')
  })
  it('moves to rejected when closed without merging', async () => {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'closed', headSha: 'h', closedAt: '2026-11-21T09:00:00Z' })
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), prOpen(d))
    expect(s.state).toBe('rejected')
    expect(s.history.at(-1)?.note).toBe('closed at 2026-11-21T09:00:00Z')
    expect(d.tracker.comments.at(-1)?.body).toBe(`The pull request was closed without merging: ${URL}`)
  })
  it('returns an open pull request unchanged and writes nothing', async () => {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'open', headSha: 'h' })
    const start = prOpen(d)
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(d.tracker.states.size).toBe(0); expect(d.tracker.comments).toHaveLength(0)
  })
  it('throws when the state is not pr_open or there is no url', async () => {
    const d = makeDeps()
    await expect(trackPullRequest(d, makeRumba(), makeTicket(), verified(d))).rejects.toThrow(/verified/)
    const { pullRequestUrl: _u, ...s } = prOpen(d)
    await expect(trackPullRequest(d, makeRumba(), makeTicket(), s)).rejects.toThrow(/pull request/)
  })
  it('lets a failed read through', async () => {
    const d = makeDeps(); d.codeHost.pullRequestError = new Error('api down')
    await expect(trackPullRequest(d, makeRumba(), makeTicket(), prOpen(d))).rejects.toThrow('api down')
  })
})
