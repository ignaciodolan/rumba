import type { Criterion, LabelNames } from './types.js'

export const CRITERIA_MARKER = 'rumba-criteria-v1'

export function renderCriteriaComment(c: Criterion[], labels: LabelNames): string {
  const items = c.map(x => `- [ ] ${x.text}`).join('\n')
  return [
    'Proposed acceptance criteria:',
    '',
    items,
    '',
    `Add the \`${labels.approved}\` label to accept these. To change them, write the final list in the ticket description under an "Acceptance criteria" heading, then add the label.`,
    '',
    `<!-- ${CRITERIA_MARKER} -->`,
    '',
  ].join('\n')
}

// Applied to trimmed lines, with no overlapping quantifiers: ticket text is untrusted.
const HEADING = /^#{1,6}\s+(.*)$/
const ITEM = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/

function headingText(raw: string): string {
  let end = raw.length
  while (end > 0 && raw[end - 1] === '#') end--
  return raw.slice(0, end).trim()
}

export function extractAcceptanceCriteria(ticketBody: string): Criterion[] | null {
  let inSection = false
  let found = false
  const texts: string[] = []
  for (const raw of ticketBody.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = HEADING.exec(line)
    if (heading) {
      if (inSection) break
      if (headingText(heading[1] ?? '').toLowerCase() === 'acceptance criteria') {
        inSection = true
        found = true
      }
      continue
    }
    if (!inSection) continue
    const text = ITEM.exec(line)?.[1]?.trim()
    if (text) texts.push(text)
  }
  if (!found || texts.length === 0) return null
  return texts.map((text, i) => ({ id: `c${i + 1}`, text, checkable: true }))
}
