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
  it('throws, with the size, when the state does not fit even without output', () => {
    const criteria = Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, text: 'x'.repeat(500), checkable: true }))
    expect(() => encodeStateComment({ ...newState('shop', t0), criteria })).toThrow(/too large to store: \d+ characters/)
  })
})

