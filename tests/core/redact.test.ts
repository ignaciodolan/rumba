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
})
