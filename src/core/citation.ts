/** How many consecutive words of a criterion a feedback item must hold to name it. */
const CRITERION_RUN = 3

/**
 * Whether a feedback item's text names a check: case-insensitively, it holds the base name of
 * one of the check's files (`fulfil.test.ts`) or that name without its last extension
 * (`fulfil.test`), or a run of three consecutive words of the criterion (all of them, in order,
 * when the criterion has fewer). Words are runs of letters and digits.
 */
export function namesCheck(text: string, files: string[], criterion: string): boolean {
  const lower = text.toLowerCase()
  for (const file of files) {
    const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    if ((base !== '' && lower.includes(base)) || (stem !== '' && lower.includes(stem))) return true
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

function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}
