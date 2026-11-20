import type { Criterion, LabelNames } from './types.js'

export const CRITERIA_MARKER = 'rumba-criteria-v1'

/** The same limits the agent's criteria have, so stored state stays within GitHub's comment size. */
const MAX_CRITERIA = 20
const MAX_CRITERION_TEXT = 500

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

// Ticket text is untrusted. These patterns match only a prefix and nothing follows them,
// so they cannot backtrack; the rest of the line is taken with string operations.
const HEADING_PREFIX = /^#{1,6}\s+/
const ITEM_PREFIX = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/
const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/

function headingText(line: string): string | null {
  const indent = line.length - line.trimStart().length
  if (indent > 3) return null
  const trimmed = line.trim()
  const prefix = HEADING_PREFIX.exec(trimmed)
  if (!prefix) return null
  let end = trimmed.length
  while (end > prefix[0].length && trimmed[end - 1] === '#') end--
  return trimmed.slice(prefix[0].length, end).trim()
}

export function extractAcceptanceCriteria(ticketBody: string): Criterion[] | null {
  let inSection = false
  let found = false
  const texts: string[] = []
  for (const line of ticketBody.split(LINE_BREAK)) {
    const heading = headingText(line)
    if (heading !== null) {
      if (inSection) break
      if (heading.toLowerCase() === 'acceptance criteria') {
        inSection = true
        found = true
      }
      continue
    }
    if (!inSection) continue
    const trimmed = line.trim()
    const prefix = ITEM_PREFIX.exec(trimmed)
    const text = prefix ? trimmed.slice(prefix[0].length).trim() : ''
    if (text) texts.push(text)
  }
  if (!found || texts.length === 0) return null
  return texts.slice(0, MAX_CRITERIA).map((text, i) => ({ id: `c${i + 1}`, text: text.slice(0, MAX_CRITERION_TEXT), checkable: true }))
}
