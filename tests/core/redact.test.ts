import { describe, expect, it } from 'vitest'
import { MAX_OUTPUT, cleanOutput } from '../../src/core/redact.js'

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
})
