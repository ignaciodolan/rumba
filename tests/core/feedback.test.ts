import { describe, expect, it } from 'vitest'
import { selectFeedback } from '../../src/core/feedback.js'
import type { FeedbackItem } from '../../src/ports/codeHost.js'

function item(over: Partial<FeedbackItem> = {}): FeedbackItem {
  return { kind: 'comment', author: 'alice', url: 'u', at: '2026-11-22T10:00:00Z', text: 'hi', canWrite: true, self: false, ...over }
}

describe('selectFeedback', () => {
  it('asks for a round on a writer review requesting changes', () => {
    const r = selectFeedback([item({ kind: 'review', reviewState: 'changes_requested', text: 'fix it' })], [])
    expect(r.requested).toBe(true)
    expect(r.feedback).toEqual([{ kind: 'review', author: 'alice', url: 'u', at: '2026-11-22T10:00:00Z', text: 'fix it' }])
  })
  it('does not ask for a round on comments alone, but still returns them', () => {
    const r = selectFeedback([item(), item({ kind: 'line', path: 'a.ts', line: 3 })], [])
    expect(r.requested).toBe(false)
    expect(r.feedback[1]).toMatchObject({ kind: 'line', path: 'a.ts', line: 3 })
  })
  it('drops approvals and empty commented reviews', () => {
    const r = selectFeedback([item({ kind: 'review', reviewState: 'approved', text: 'lgtm' }), item({ kind: 'review', reviewState: 'commented', text: ' ' })], [])
    expect(r.feedback).toEqual([])
  })
  it('keeps a commented review that has a body', () => {
    expect(selectFeedback([item({ kind: 'review', reviewState: 'commented', text: 'note' })], []).feedback).toHaveLength(1)
  })
  it('ignores non-writers and the account Rumba runs as', () => {
    const r = selectFeedback([
      item({ author: 'mallory', canWrite: false, kind: 'review', reviewState: 'changes_requested', text: 'evil' }),
      item({ author: 'rumba-bot', self: true, kind: 'review', reviewState: 'changes_requested', text: 'mine' }),
    ], [])
    expect(r).toEqual({ requested: false, feedback: [] })
  })
  it('redacts secrets and cuts long text', () => {
    const r = selectFeedback([item({ text: 'token s3cret' }), item({ text: 'x'.repeat(5000) })], ['s3cret'])
    expect(r.feedback[0]?.text).toBe('token [redacted]')
    expect(r.feedback[1]?.text.length).toBeLessThan(2100)
  })
  it('keeps the newest 20, oldest first', () => {
    const items = Array.from({ length: 25 }, (_, i) => item({ text: `c${i}`, at: new Date(Date.UTC(2026, 10, 22, 0, i)).toISOString() })).reverse()
    const r = selectFeedback(items, [])
    expect(r.feedback).toHaveLength(20)
    expect(r.feedback[0]?.text).toBe('c5')
    expect(r.feedback[19]?.text).toBe('c24')
  })
})
