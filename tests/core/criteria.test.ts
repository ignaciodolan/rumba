import { describe, expect, it } from 'vitest'
import { CRITERIA_MARKER, extractAcceptanceCriteria, renderCriteriaComment } from '../../src/core/criteria.js'
import { defaultLabels } from '../../src/core/labels.js'

describe('criteria', () => {
  it('extracts criteria from a description section', () => {
    const body = 'Intro\n\n## Acceptance criteria\n- Export button on the orders page\n- CSV has a header row\n\n## Notes\n- ignore me'
    expect(extractAcceptanceCriteria(body)).toEqual([
      { id: 'c1', text: 'Export button on the orders page', checkable: true },
      { id: 'c2', text: 'CSV has a header row', checkable: true },
    ])
  })
  it('returns null without the heading or with an empty list', () => {
    expect(extractAcceptanceCriteria('just text')).toBeNull()
    expect(extractAcceptanceCriteria('## Acceptance criteria\n\n## Next')).toBeNull()
    expect(extractAcceptanceCriteria('')).toBeNull()
  })
  it('accepts any heading level, any case, and other list markers', () => {
    expect(extractAcceptanceCriteria('### ACCEPTANCE CRITERIA\n* one\n1. two\n- [ ] three')).toEqual([
      { id: 'c1', text: 'one', checkable: true },
      { id: 'c2', text: 'two', checkable: true },
      { id: 'c3', text: 'three', checkable: true },
    ])
  })
  it('renders a checklist that names the approval label', () => {
    const out = renderCriteriaComment([{ id: 'c1', text: 'A', checkable: true }], defaultLabels('hub'))
    expect(out).toContain('- [ ] A')
    expect(out).toContain('`rumba-approved`')
    expect(out).toContain(CRITERIA_MARKER)
    expect(out).toContain('Add the `rumba-approved` label to accept these. To change them, write the final list in the ticket description under an "Acceptance criteria" heading, then add the label.')
  })
  it('parses a very long line of spaces and hashes quickly', () => {
    const line = '#' + ' '.repeat(100_000) + '# '.repeat(50_000)
    const t = Date.now()
    expect(extractAcceptanceCriteria(`## Acceptance criteria\n- ${line}\n${line}\n## x`)).not.toBeNull()
    expect(extractAcceptanceCriteria(`${line}x`)).toBeNull()
    expect(Date.now() - t).toBeLessThan(500)
  })
  it('is linear on a lone carriage return after long whitespace', () => {
    const heading = '#' + ' '.repeat(200_000) + 'a\rb'
    const item = '- ' + ' '.repeat(200_000) + 'a\rb'
    const t = Date.now()
    expect(extractAcceptanceCriteria(`${heading}\n## Acceptance criteria\n${item}\n${heading}`)).toEqual([
      { id: 'c1', text: 'a', checkable: true },
    ])
    expect(Date.now() - t).toBeLessThan(500)
  })
  it('does not treat a heading indented four spaces as a heading', () => {
    expect(extractAcceptanceCriteria('## Acceptance criteria\n- one\n    ## code\n- two')).toEqual([
      { id: 'c1', text: 'one', checkable: true },
      { id: 'c2', text: 'two', checkable: true },
    ])
    expect(extractAcceptanceCriteria('    ## Acceptance criteria\n- one')).toBeNull()
  })
})
