import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT, checkOutputMax, cleanOutput, redact } from '../../src/core/redact.js'

describe('cleanOutput', () => {
  it('redacts secrets and ignores empty ones', () => {
    expect(cleanOutput('token abc123 and abc123', ['abc123', ''])).toBe('token [redacted] and [redacted]')
  })
  it('keeps the tail of long output', () => {
    const out = cleanOutput('x'.repeat(5000) + 'END', [])
    expect(out.startsWith('[…cut]\n')).toBe(true); expect(out.endsWith('END')).toBe(true)
    expect(out.length).toBe(MAX_OUTPUT + '[…cut]\n'.length)
  })
  it('replaces the longest secret first whatever the order', () => {
    expect(cleanOutput('x abc123 y', ['abc', 'abc123'])).toBe('x [redacted] y')
    expect(cleanOutput('x abc123 y', ['abc123', 'abc'])).toBe('x [redacted] y')
  })
  it('redacts base64, base64url and URL-encoded forms', () => {
    const secret = 's3cret-value'
    const b64 = Buffer.from(secret).toString('base64')
    const plus = 'a+b/c?d'
    const out = cleanOutput(`b ${b64} u ${encodeURIComponent(plus)}`, [secret, plus])
    expect(out).toBe('b [redacted] u [redacted]')
    const url = Buffer.from('a>b?c>d').toString('base64url')
    expect(cleanOutput(`t ${url}`, ['a>b?c>d'])).toBe('t [redacted]')
  })
  it('keeps the tail up to a given maximum', () => {
    const out = cleanOutput('x'.repeat(1000) + 'END', [], 200)
    expect(out).toBe('[…cut]\n' + ('x'.repeat(1000) + 'END').slice(-200))
    expect(cleanOutput('short', [], 200)).toBe('short')
  })
})

describe('checkOutputMax', () => {
  it('shares 12,000 characters among the checks, between 200 and MAX_OUTPUT each', () => {
    expect(checkOutputMax(1)).toBe(MAX_OUTPUT)
    expect(checkOutputMax(3)).toBe(MAX_OUTPUT)
    expect(checkOutputMax(4)).toBe(3000)
    expect(checkOutputMax(20)).toBe(600)
    expect(checkOutputMax(100)).toBe(200)
  })
})

describe('redact', () => {
  it('replaces secrets and their encoded forms without cutting', () => {
    const long = 'x'.repeat(10_000)
    expect(redact(`${long} s3cret ${Buffer.from('s3cret').toString('base64')}`, ['s3cret', ''])).toBe(`${long} [redacted] [redacted]`)
    expect(redact('nothing here', [])).toBe('nothing here')
  })
})
