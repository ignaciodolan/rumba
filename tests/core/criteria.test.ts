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
})
