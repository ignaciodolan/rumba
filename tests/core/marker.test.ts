import { describe, expect, it } from 'vitest'
import { MAX_PULL_REQUEST_BODY } from '../../src/core/evidence.js'
import { isOwnBody, isOwnReply, LEGACY_REPLY_OPENINGS, OWN_MARKER, withMarker } from '../../src/core/marker.js'
import { MAX_STATE_COMMENT } from '../../src/core/stateComment.js'

/** GitHub's limit on a comment or a pull request body. */
const GITHUB_BODY_LIMIT = 65536

describe('the own-comment marker', () => {
  it('is one hidden line', () => {
    expect(OWN_MARKER).toBe('<!-- rumba:own -->')
  })

  it('puts the marker line first, once', () => {
    expect(withMarker('Revised the change.')).toBe('<!-- rumba:own -->\nRevised the change.')
    expect(withMarker(withMarker('Revised the change.'))).toBe('<!-- rumba:own -->\nRevised the change.')
    expect(withMarker('')).toBe('<!-- rumba:own -->\n')
  })

  it('knows a body by its exact first line, with either line ending', () => {
    expect(isOwnBody('<!-- rumba:own -->\nRevised.')).toBe(true)
    expect(isOwnBody('<!-- rumba:own -->\r\nRevised.')).toBe(true)
    expect(isOwnBody('<!-- rumba:own -->')).toBe(true)
    expect(isOwnBody(withMarker('Revised.'))).toBe(true)
  })

  it.each([
    ['a quoted marker', '> <!-- rumba:own -->\n> Revised.\n\nPlease also rename it.'],
    ['a marker later in the body', 'Please rename it.\n<!-- rumba:own -->'],
    ['leading spaces', '  <!-- rumba:own -->\nRevised.'],
    ['text before it', 'Note <!-- rumba:own -->\nRevised.'],
    ['text after it on the line', '<!-- rumba:own --> but by bob\nRevised.'],
    ['no marker at all', 'Please rename it.'],
    ['an empty body', ''],
  ])('does not count %s', (_name, body) => {
    expect(isOwnBody(body)).toBe(false)
  })

  it('lists exactly the openings of the replies Rumba wrote before the marker', () => {
    expect(LEGACY_REPLY_OPENINGS).toEqual([
      'Rumba made no change in this round.', 'Revised as asked with the ', '- Review by ', '- Line comment on ', '- Comment by ', '- Check for ',
    ])
  })

  it('knows a reply by the marker, or by one of the old openings', () => {
    expect(isOwnReply('<!-- rumba:own -->\nAnything')).toBe(true)
    for (const opening of LEGACY_REPLY_OPENINGS) expect(isOwnReply(`${opening}rest`)).toBe(true)
    expect(isOwnReply('Please also round the totals')).toBe(false)
    expect(isOwnReply('> - Review by alice: done\n\nNot done.')).toBe(false)
    expect(isOwnReply(' - Review by alice')).toBe(false)
  })

  it('does not take an old opening for the marker when adding it', () => {
    expect(isOwnBody('- Review by alice')).toBe(false)
    expect(withMarker('- Review by alice')).toBe('<!-- rumba:own -->\n- Review by alice')
  })

  it('cannot push a state comment or a pull request body over GitHub\'s limit', () => {
    const line = OWN_MARKER.length + 1
    expect(MAX_STATE_COMMENT + line).toBeLessThanOrEqual(GITHUB_BODY_LIMIT)
    expect(MAX_PULL_REQUEST_BODY + line).toBeLessThanOrEqual(GITHUB_BODY_LIMIT)
  })
})
