import { describe, expect, it } from 'vitest'
import { decodeStateComment, encodeStateComment } from '../../src/core/stateComment.js'
import { newState } from '../../src/core/states.js'

const t0 = new Date('2026-01-01T00:00:00.000Z')

describe('stateComment', () => {
  it('round-trips', () => {
    const s = { ...newState('shop', t0), kind: 'bug' as const, criteria: [{ id: 'c1', text: 'Login works', checkable: true }] }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it.each(['merged', 'rejected'] as const)('round-trips a ticket in %s', (name) => {
    const s = { ...newState('shop', t0), state: name, lastDurable: name, pullRequestUrl: 'https://github.com/acme/shop/pull/7' }
    expect(encodeStateComment(s).split('\n')[0]).toContain(name)
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it('round-trips a ticket in changes_requested with its feedback', () => {
    const s = {
      ...newState('shop', t0), state: 'changes_requested' as const, lastDurable: 'changes_requested' as const,
      pushedAt: '2026-01-01T00:00:00.000Z',
      answeredAt: '2026-01-02T00:00:00.000Z',
      feedback: [
        { kind: 'review' as const, author: 'alice', url: 'https://github.com/acme/shop/pull/7#r1', at: '2026-01-02T00:00:00.000Z', text: 'Please add a test' },
        { kind: 'line' as const, author: 'alice', url: 'https://github.com/acme/shop/pull/7#r2', at: '2026-01-02T00:00:00.000Z', text: 'Rename this', path: 'src/a.ts', line: 12 },
      ],
    }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it('round-trips the review round count and a check changed after review', () => {
    const s = { ...newState('shop', t0), reviewRounds: 1, checks: [{ criterionId: 'c1', command: 'npm test', files: ['a.test.ts'], changedAfterReview: true, changeAskedIn: 'https://example.test/pr/1#pullrequestreview-1' }] }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it.each([{ reviewRounds: -1 }, { reviewRounds: 1.5 }, { reviewRounds: '1' }])('rejects %o', (bad) => {
    const comment = encodeStateComment(newState('shop', t0)).replace('"fixAttempts": 0,', `"fixAttempts": 0, "reviewRounds": ${JSON.stringify(Object.values(bad)[0])},`)
    expect(decodeStateComment(comment)).toBeNull()
  })
  it('returns null for other comments and for broken json', () => {
    expect(decodeStateComment('looks good to me')).toBeNull()
    expect(decodeStateComment('```json\n{ "marker": "rumba-state-v1", \n```')).toBeNull()
  })
  it('returns null for json without the marker or that is not an object', () => {
    expect(decodeStateComment('```json\n{ "rumba": "shop" }\n```')).toBeNull()
    expect(decodeStateComment('```json\n[1]\n```')).toBeNull()
    expect(decodeStateComment('```json\nnull\n```')).toBeNull()
    expect(decodeStateComment('')).toBeNull()
  })
  it('does not carry the marker on the result', () => {
    expect(decodeStateComment(encodeStateComment(newState('shop', t0)))).not.toHaveProperty('marker')
  })
  it('starts with a line a person can read', () => {
    expect(encodeStateComment(newState('shop', t0)).split('\n')[0]).toMatch(/Rumba `shop`.*queued/)
  })
  it('survives triple backticks and newlines in text', () => {
    const base = newState('shop', t0)
    const s = {
      ...base,
      criteria: [{ id: 'c1', text: 'Has ```fence```\nand a newline', checkable: true }],
      history: [{ state: 'needs_human' as const, at: t0.toISOString(), note: 'bad ```\n```json {"marker":"rumba-state-v1"}' }],
    }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  describe('rejects forged state', () => {
    const forge = (patch: Record<string, unknown>) =>
      '```json\n' + JSON.stringify({ marker: 'rumba-state-v1', ...newState('shop', t0), ...patch }) + '\n```'
    it('accepts an untouched forged-style block', () => {
      expect(decodeStateComment(forge({}))).toEqual(newState('shop', t0))
    })
    const entry = { kind: 'comment', author: 'alice', url: 'u', at: 'a', text: 't' }
    it.each([
      ['feedback that is not a list', { feedback: 'x' }],
      ['feedback of an unknown kind', { feedback: [{ ...entry, kind: 'praise' }] }],
      ['feedback without an author', { feedback: [{ ...entry, author: undefined }] }],
      ['feedback with a text that is not a string', { feedback: [{ ...entry, text: 5 }] }],
      ['feedback with a fractional line', { feedback: [{ ...entry, kind: 'line', line: 1.5 }] }],
      ['feedback with a negative line', { feedback: [{ ...entry, kind: 'line', line: -1 }] }],
      ['feedback with an unknown field', { feedback: [{ ...entry, extra: 1 }] }],
      ['a pushedAt that is not a string', { pushedAt: 3 }],
      ['an answeredAt that is not a string', { answeredAt: 3 }],
    ])('refuses %s', (_name, patch) => {
      expect(decodeStateComment(forge(patch))).toBeNull()
    })
    it.each([
      ['unknown state', { state: 'abandoned' }],
      ['non-durable lastDurable', { lastDurable: 'building' }],
      ['wrong field type', { fixAttempts: '3' }],
      ['negative counter', { errorCount: -1 }],
      ['bad rumba name', { rumba: '../x' }],
      ['bad check shape', { checks: [{ criterionId: 'c1', command: 'x', files: 'a' }] }],
      ['bad version', { version: 2 }],
    ])('%s decodes to null', (_n, patch) => {
      expect(decodeStateComment(forge(patch))).toBeNull()
    })
    it('drops unknown keys', () => {
      expect(decodeStateComment(forge({ extra: 'x' }))).not.toHaveProperty('extra')
    })
  })
})

describe('encodeStateComment size', () => {
  const results = (n: number, size: number, passed: boolean) =>
    Array.from({ length: n }, (_, i) => ({ criterionId: `c${i}`, passed, exitCode: passed ? 0 : 1, output: `${i}`.padEnd(size, 'o') }))
  const dropped = (rs: { output: string }[]) => rs.map((r) => ({ ...r, output: '[output dropped: state too large]' }))

  it('drops check output when the state would not fit, without changing the state', () => {
    const s = { ...newState('shop', t0), before: results(20, 4000, false), after: results(20, 4000, true) }
    const copy = structuredClone(s)
    const body = encodeStateComment(s)
    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(s).toEqual(copy)
    expect(decodeStateComment(body)).toEqual({ ...s, before: dropped(s.before), after: dropped(s.after) })
  })
  it('leaves a state under the limit unchanged', () => {
    const s = { ...newState('shop', t0), before: results(2, 1000, false), after: results(2, 1000, true) }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it('cuts feedback texts, keeping their end, before giving up', () => {
    const feedback = Array.from({ length: 30 }, (_, i) => ({
      kind: 'comment' as const, author: 'alice', url: `u${i}`, at: 'a', text: `${'x'.repeat(4000)}END${i}`,
    }))
    const s = { ...newState('shop', t0), state: 'changes_requested' as const, lastDurable: 'changes_requested' as const, feedback }
    const copy = structuredClone(s)
    const body = encodeStateComment(s)
    expect(body.length).toBeLessThanOrEqual(60_000)
    expect(s).toEqual(copy)
    const back = decodeStateComment(body)!.feedback!
    expect(back).toHaveLength(30)
    back.forEach((f, i) => {
      expect(f.text.endsWith(`END${i}`)).toBe(true)
      expect(f.text.length).toBeLessThan(copy.feedback![i]!.text.length)
      expect(f).toMatchObject({ author: 'alice', url: `u${i}` })
    })
  })
  it('leaves feedback that fits untouched', () => {
    const feedback = [{ kind: 'comment' as const, author: 'alice', url: 'u', at: 'a', text: 'y'.repeat(2000) }]
    const s = { ...newState('shop', t0), feedback }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it('throws, with the size, when the state does not fit even without output', () => {
    const criteria = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, text: 'x'.repeat(500), checkable: true }))
    expect(() => encodeStateComment({ ...newState('shop', t0), criteria })).toThrow(/too large to store: \d+ characters/)
  })
})

