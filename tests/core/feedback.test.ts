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
  it('does not ask for a round on pull request comments alone, but still returns them', () => {
    const r = selectFeedback([item(), item({ text: 'more', at: '2026-11-22T11:00:00Z' })], [])
    expect(r.requested).toBe(false)
    expect(r.feedback.map((f) => f.text)).toEqual(['hi', 'more'])
  })
  it('drops approvals and empty commented reviews', () => {
    const r = selectFeedback([item({ kind: 'review', reviewState: 'approved', text: 'lgtm' }), item({ kind: 'review', reviewState: 'commented', text: ' ' })], [])
    expect(r.feedback).toEqual([])
  })
  it('keeps a commented review that has a body', () => {
    expect(selectFeedback([item({ kind: 'review', reviewState: 'commented', text: 'note' })], []).feedback).toHaveLength(1)
  })
  it('ignores non-writers and Rumba\'s own comments', () => {
    const r = selectFeedback([
      item({ author: 'mallory', canWrite: false, kind: 'review', reviewState: 'changes_requested', text: 'evil' }),
      item({ author: 'rumba-bot', self: true, text: '<!-- rumba:own -->\nmine' }),
    ], [])
    expect(r).toEqual({ requested: false, feedback: [] })
  })
  it('keeps a writer who shares Rumba\'s account when the item is not Rumba\'s own', () => {
    const r = selectFeedback([item({ author: 'alice', kind: 'review', reviewState: 'changes_requested', text: 'rename it' })], [])
    expect(r.requested).toBe(true)
    expect(r.feedback.map((f) => f.text)).toEqual(['rename it'])
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
  describe('the latest decision of each reviewer', () => {
    const review = (author: string, reviewState: 'changes_requested' | 'approved' | 'commented', at: string, text = 'text') =>
      item({ kind: 'review', author, reviewState, at, text })
    it('asks for no round when the reviewer approved after requesting changes, and drops the old request', () => {
      const r = selectFeedback([review('alice', 'changes_requested', '2026-11-22T09:00:00Z', 'fix it'), review('alice', 'approved', '2026-11-22T10:00:00Z', 'ok')], [])
      expect(r).toEqual({ requested: false, feedback: [] })
    })
    it('asks for a round when the reviewer requested changes after approving', () => {
      const r = selectFeedback([review('alice', 'approved', '2026-11-22T09:00:00Z', 'ok'), review('alice', 'changes_requested', '2026-11-22T10:00:00Z', 'wait')], [])
      expect(r.requested).toBe(true)
      expect(r.feedback.map((f) => f.text)).toEqual(['wait'])
    })
    it('keeps the request of one reviewer when another approves', () => {
      const r = selectFeedback([review('bob', 'changes_requested', '2026-11-22T09:00:00Z', 'bob wants'), review('alice', 'approved', '2026-11-22T10:00:00Z')], [])
      expect(r.requested).toBe(true)
      expect(r.feedback.map((f) => f.text)).toEqual(['bob wants'])
    })
    it('does not let a later commented review undo a request', () => {
      const r = selectFeedback([review('alice', 'changes_requested', '2026-11-22T09:00:00Z', 'fix it'), review('alice', 'commented', '2026-11-22T10:00:00Z', 'note')], [])
      expect(r.requested).toBe(true)
      expect(r.feedback.map((f) => f.text)).toEqual(['fix it', 'note'])
    })
  })
  describe('a commented review or a line comment', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 10, 22, 10, m)).toISOString()
    const commented = (author: string, m: number, text = '') => item({ kind: 'review', author, reviewState: 'commented', at: at(m), text })
    const line = (author: string, m: number, text: string) => item({ kind: 'line', author, at: at(m), text, path: 'src/orders/total.ts', line: m })
    const approval = (author: string, m: number) => item({ kind: 'review', author, reviewState: 'approved', at: at(m), text: '' })
    it('starts a round with its body and three line comments stored', () => {
      const r = selectFeedback([commented('alice', 5, 'Three things.'), line('alice', 5, 'round it'), line('alice', 5, 'name it'), line('alice', 5, 'test it')], [])
      expect(r.requested).toBe(true)
      expect(r.feedback.map((f) => [f.kind, f.text])).toEqual([['review', 'Three things.'], ['line', 'round it'], ['line', 'name it'], ['line', 'test it']])
    })
    it('starts a round when the review body is empty but it has line comments', () => {
      const r = selectFeedback([commented('alice', 5), line('alice', 5, 'round it')], [])
      expect(r.requested).toBe(true)
      expect(r.feedback.map((f) => f.text)).toEqual(['round it'])
    })
    it('starts a round on a line comment alone', () => {
      expect(selectFeedback([line('alice', 5, 'round it')], []).requested).toBe(true)
    })
    it('starts a round on a commented review with a body alone', () => {
      expect(selectFeedback([commented('alice', 5, 'please split this')], []).requested).toBe(true)
    })
    it('starts nothing when the same reviewer approved after it', () => {
      const r = selectFeedback([commented('alice', 5, 'nit'), line('alice', 5, 'round it'), approval('alice', 6)], [])
      expect(r.requested).toBe(false)
    })
    it('still starts a round for bob when only alice approved', () => {
      const r = selectFeedback([commented('bob', 5, 'nit'), line('bob', 5, 'round it'), approval('alice', 6)], [])
      expect(r.requested).toBe(true)
    })
    it('starts a round when the approval came before the comment', () => {
      expect(selectFeedback([approval('alice', 4), line('alice', 5, 'round it')], []).requested).toBe(true)
    })
    it('starts nothing for an empty commented review alone', () => {
      expect(selectFeedback([commented('alice', 5)], []).requested).toBe(false)
    })
    it('starts nothing from a non-writer', () => {
      const r = selectFeedback([{ ...commented('mallory', 5, 'evil'), canWrite: false }, { ...line('mallory', 5, 'evil'), canWrite: false }], [])
      expect(r).toEqual({ requested: false, feedback: [] })
    })
  })
})
