import type { Feedback } from './types.js'

/** How many consecutive words of a criterion a feedback item must hold to name it. */
const CRITERION_RUN = 3

/**
 * Whether a feedback item asks about a check: a line comment on one of the check's files (its
 * path comes from the code host, not from the reviewer's text), or text that names the check.
 */
export function asksAbout(item: Pick<Feedback, 'kind' | 'text' | 'path'>, files: string[], criterion: string): boolean {
  if (item.kind === 'line' && item.path !== undefined && files.includes(item.path)) return true
  return namesCheck(item.text, files, criterion)
}

/**
 * Whether a feedback item's text names a check: case-insensitively, it holds the base name of
 * one of the check's files (`fulfil.test.ts`) or that name without its last extension
 * (`fulfil.test`), with no letter, digit or underscore right before or after it; or a run of
 * three consecutive words of the criterion (all of them, in order, when the criterion has
 * fewer). Words are runs of letters and digits.
 */
export function namesCheck(text: string, files: string[], criterion: string): boolean {
  const lower = text.toLowerCase()
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    if (holdsName(lower, base) || holdsName(lower, stem)) return true
  }
  const said = ` ${words(text).join(' ')} `
  const asked = words(criterion)
  const run = Math.min(CRITERION_RUN, asked.length)
  if (run === 0) return false
  for (let i = 0; i + run <= asked.length; i++) {
    if (said.includes(` ${asked.slice(i, i + run).join(' ')} `)) return true
  }
  return false
}

/** Whether `text` holds `name` with a boundary on both sides: the text's start or end, or neither a letter, a digit nor an underscore. */
function holdsName(text: string, name: string): boolean {
  if (name === '') return false
  const inWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}_]/u.test(c)
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    if (!inWord(text[at - 1]) && !inWord(text[at + name.length])) return true
  }
  return false
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}
