import { describe, expect, it } from 'vitest'
import { decodeStateComment, encodeStateComment } from '../../src/core/stateComment.js'
import { newState } from '../../src/core/states.js'

const t0 = new Date('2026-01-01T00:00:00.000Z')

describe('stateComment', () => {
  it('round-trips', () => {
    const s = { ...newState('hub', t0), kind: 'bug' as const, criteria: [{ id: 'c1', text: 'Login works', checkable: true }] }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  it('returns null for other comments and for broken json', () => {
    expect(decodeStateComment('looks good to me')).toBeNull()
    expect(decodeStateComment('```json\n{ "marker": "rumba-state-v1", \n```')).toBeNull()
  })
  it('returns null for json without the marker or that is not an object', () => {
    expect(decodeStateComment('```json\n{ "rumba": "hub" }\n```')).toBeNull()
    expect(decodeStateComment('```json\n[1]\n```')).toBeNull()
    expect(decodeStateComment('```json\nnull\n```')).toBeNull()
    expect(decodeStateComment('')).toBeNull()
  })
  it('does not carry the marker on the result', () => {
    expect(decodeStateComment(encodeStateComment(newState('hub', t0)))).not.toHaveProperty('marker')
  })
  it('starts with a line a person can read', () => {
    expect(encodeStateComment(newState('hub', t0)).split('\n')[0]).toMatch(/Rumba `hub`.*queued/)
  })
  it('survives triple backticks and newlines in text', () => {
    const base = newState('hub', t0)
    const s = {
      ...base,
      criteria: [{ id: 'c1', text: 'Has ```fence```\nand a newline', checkable: true }],
      history: [{ state: 'needs_human' as const, at: t0.toISOString(), note: 'bad ```\n```json {"marker":"rumba-state-v1"}' }],
    }
    expect(decodeStateComment(encodeStateComment(s))).toEqual(s)
  })
  describe('rejects forged state', () => {
    const forge = (patch: Record<string, unknown>) =>
      '```json\n' + JSON.stringify({ marker: 'rumba-state-v1', ...newState('hub', t0), ...patch }) + '\n```'
    it('accepts an untouched forged-style block', () => {
      expect(decodeStateComment(forge({}))).toEqual(newState('hub', t0))
    })
    it.each([
      ['unknown state', { state: 'merged' }],
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
