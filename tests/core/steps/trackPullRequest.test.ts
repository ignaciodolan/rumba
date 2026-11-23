import { describe, expect, it } from 'vitest'
import { trackPullRequest } from '../../../src/core/steps/trackPullRequest.js'
import { makeDeps, makeRumba, makeTicket, verified } from '../../../src/testing/fakes.js'
import type { FeedbackItem, LabelAdded } from '../../../src/ports/codeHost.js'
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
  it('keeps the recorded outcome and error count when the exit comment fails', async () => {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'merged', headSha: 'h' })
    d.tracker.comment = async () => { throw new Error('comment api down') }
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), { ...prOpen(d), errorCount: 2 })
    expect(s).toMatchObject({ state: 'merged', errorCount: 2 })
    expect(d.tracker.states.get('123')).toMatchObject({ state: 'merged', errorCount: 2 })
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

function fb(over: Partial<FeedbackItem> = {}): FeedbackItem {
  return { kind: 'comment', author: 'alice', url: 'https://example.test/pr/42#c1', at: '2099-01-01T00:00:00Z', text: 'hi', canWrite: true, self: false, ...over }
}
const REQUEST_AT = '2099-01-01T00:00:00Z'
const REQUEST = { kind: 'review', reviewState: 'changes_requested', text: 'please rename' } as const

describe('trackPullRequest feedback', () => {
  function open(labels: string[] = []) {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'open', headSha: 'h', labels })
    return { d, start: { ...prOpen(d), pushedAt: '2026-11-20T00:00:00Z' } }
  }
  it('starts a round on a changes-requested review and comments without quoting it', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb(REQUEST)])
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), start)
    expect(s.state).toBe('changes_requested')
    expect(s.history.at(-1)?.note).toBe('review feedback')
    expect(s.feedback).toHaveLength(1)
    expect(d.tracker.states.get('123')).toEqual(s)
    expect(d.tracker.comments.at(-1)?.body).toBe(`Review feedback arrived on the pull request (1 comment). Rumba will revise the change on a later run: ${URL}`)
    expect(d.codeHost.labelsRemoved).toEqual([])
  })
  it('stores line and pull request comments along with the review', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb(REQUEST), fb({ kind: 'line', path: 'a.ts', line: 7, text: 'here' }), fb({ text: 'general' })])
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), start)
    expect(s.feedback?.map((f) => f.kind).sort()).toEqual(['comment', 'line', 'review'])
  })
  it('changes nothing for comments alone, an approval, or feedback before the push', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb(), fb({ kind: 'review', reviewState: 'approved', text: 'ok' }), fb({ ...REQUEST, at: '2026-11-19T00:00:00Z' })])
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(d.tracker.states.size).toBe(0); expect(d.tracker.comments).toHaveLength(0)
  })
  it('ignores a review from someone without write access and leaks none of her text', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb({ ...REQUEST, author: 'mallory', canWrite: false, text: 'MALLORY-TEXT' })])
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(JSON.stringify([...d.tracker.states.values()])).not.toContain('MALLORY')
    expect(JSON.stringify(d.tracker.comments)).not.toContain('MALLORY')
    expect(JSON.stringify(d.codeHost.labelsRemoved)).not.toContain('MALLORY')
  })
  it('ignores feedback written by the account Rumba runs as', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb({ ...REQUEST, author: 'rumba-bot', self: true })])
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
  })
  const added = (over: Partial<LabelAdded> = {}): LabelAdded => ({ by: 'alice', at: '2026-11-21T00:00:00Z', canWrite: true, self: false, ...over })
  it('starts a round from the revise label alone, with no feedback, and removes the label', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added())
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), start)
    expect(s).toMatchObject({ state: 'changes_requested', feedback: [] })
    expect(d.codeHost.labelsRemoved).toEqual([{ url: URL, label: 'rumba-revise' }])
    expect(d.tracker.comments.at(-1)?.body).toBe(`Rumba was asked to revise the change on the pull request. It will do so on a later run: ${URL}`)
  })
  it('starts nothing for a label from someone without write access, and leaves it on', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added({ by: 'tess', canWrite: false }))
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(d.codeHost.labelsRemoved).toEqual([]); expect(d.tracker.states.size).toBe(0)
  })
  it('starts nothing for a label the account Rumba runs as added', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added({ by: 'rumba-bot', self: true }))
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(d.codeHost.labelsRemoved).toEqual([])
  })
  it('starts nothing for a label added before the push, and removes it', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added({ at: '2026-11-19T00:00:00Z' }))
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(d.codeHost.labelsRemoved).toEqual([{ url: URL, label: 'rumba-revise' }])
    expect(d.tracker.states.size).toBe(0); expect(d.tracker.comments).toHaveLength(0)
  })
  it('does not fail when removing a stale label fails', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added({ at: '2026-11-19T00:00:00Z' }))
    const tried: string[] = []
    d.codeHost.removeLabel = async (_url, label) => { tried.push(label); throw new Error('label api down') }
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    expect(tried).toEqual(['rumba-revise'])
  })
  it('keeps the label of a non-writer when a writer asked for changes in a review', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added({ by: 'tess', canWrite: false })); d.codeHost.feedback.set(URL, [fb(REQUEST)])
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), start)).state).toBe('changes_requested')
    expect(d.codeHost.labelsRemoved).toEqual([])
  })
  it('removes a stale label when a writer\'s changes-requested review starts the round', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added({ at: '2026-11-19T00:00:00Z' })); d.codeHost.feedback.set(URL, [fb(REQUEST)])
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), start)).state).toBe('changes_requested')
    expect(d.codeHost.labelsRemoved).toEqual([{ url: URL, label: 'rumba-revise' }])
  })
  it('keeps the line comments of a review submitted after the push', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb(REQUEST), fb({ kind: 'line', path: 'a.ts', line: 7, text: 'here', at: REQUEST_AT })])
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), start)).feedback?.map((f) => f.kind).sort()).toEqual(['line', 'review'])
  })
  it('redacts secrets and cuts long text', async () => {
    const { d, start } = open(); d.secrets.push('s3cret')
    d.codeHost.feedback.set(URL, [fb({ ...REQUEST, text: 'uses s3cret' }), fb({ text: 'y'.repeat(5000) })])
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), start)
    expect(JSON.stringify(s.feedback)).not.toContain('s3cret')
    expect(Math.max(...(s.feedback ?? []).map((f) => f.text.length))).toBeLessThan(2100)
  })
  it('keeps the round and the error count when removing the label fails', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added())
    const tried: string[] = []
    d.codeHost.removeLabel = async (_url, label) => { tried.push(label); throw new Error('label api down') }
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), { ...start, errorCount: 2 })
    expect(tried).toEqual(['rumba-revise'])
    expect(s).toMatchObject({ state: 'changes_requested', errorCount: 2 }); expect(s.feedback).toHaveLength(0)
    expect(d.tracker.states.get('123')).toMatchObject({ state: 'changes_requested', errorCount: 2 })
  })
  it('keeps the round and the error count when the ticket comment fails', async () => {
    const { d, start } = open(); d.codeHost.feedback.set(URL, [fb(REQUEST)])
    d.tracker.comment = async () => { throw new Error('comment api down') }
    const s = await trackPullRequest(d, makeRumba(), makeTicket(), { ...start, errorCount: 2 })
    expect(s).toMatchObject({ state: 'changes_requested', errorCount: 2 }); expect(s.feedback).toHaveLength(1)
  })
  it('writes the state, then removes the label, then comments', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.feedback.set(URL, [fb(REQUEST)]); d.codeHost.labelEvents.set(URL, added())
    const order: string[] = []
    const write = d.tracker.writeState.bind(d.tracker); const comment = d.tracker.comment.bind(d.tracker); const remove = d.codeHost.removeLabel.bind(d.codeHost)
    d.tracker.writeState = async (...a) => { order.push('write'); return write(...a) }
    d.codeHost.removeLabel = async (...a) => { order.push('label'); return remove(...a) }
    d.tracker.comment = async (...a) => { order.push('comment'); return comment(...a) }
    await trackPullRequest(d, makeRumba(), makeTicket(), start)
    expect(order).toEqual(['write', 'label', 'comment'])
  })
  it('reads feedback since the later of the last push and the last answer', async () => {
    const { d, start } = open(); const answered = { ...start, answeredAt: '2026-11-22T00:00:00Z' }
    d.codeHost.feedback.set(URL, [fb({ ...REQUEST, at: '2026-11-21T00:00:00Z' })])
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), answered)).toEqual(answered)
    d.codeHost.feedback.set(URL, [fb({ ...REQUEST, at: '2026-11-23T00:00:00Z' })])
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), answered)).state).toBe('changes_requested')
  })
  it('takes a label added before the last answer as stale', async () => {
    const { d, start } = open(['rumba-revise']); d.codeHost.labelEvents.set(URL, added())
    const answered = { ...start, answeredAt: '2026-11-22T00:00:00Z' }
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), answered)).toEqual(answered)
    expect(d.codeHost.labelsRemoved).toEqual([{ url: URL, label: 'rumba-revise' }])
  })
  it('keeps reading since the push when it is later than the answer', async () => {
    const { d, start } = open(); const answered = { ...start, answeredAt: '2026-11-19T00:00:00Z' }
    d.codeHost.feedback.set(URL, [fb({ ...REQUEST, at: '2026-11-19T12:00:00Z' })])
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), answered)).toEqual(answered)
  })
  it('uses the pr_open history time when there is no pushedAt', async () => {
    const d = makeDeps(); d.codeHost.pullRequests.set(URL, { state: 'open', headSha: 'h' })
    const start = prOpen(d); const opened = start.history.at(-1)?.at as string
    d.codeHost.feedback.set(URL, [fb({ ...REQUEST, at: new Date(Date.parse(opened) - 1000).toISOString() })])
    expect(await trackPullRequest(d, makeRumba(), makeTicket(), start)).toEqual(start)
    d.codeHost.feedback.set(URL, [fb({ ...REQUEST, at: new Date(Date.parse(opened) + 1000).toISOString() })])
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), start)).state).toBe('changes_requested')
  })
})
