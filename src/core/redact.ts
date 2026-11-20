export const MAX_OUTPUT = 4000

const CUT_MARK = '[…cut]\n'

/** Each non-empty secret plus its base64, base64url and URL-encoded forms, longest first. */
function forms(secrets: string[]): string[] {
  const all = new Set<string>()
  for (const secret of secrets) {
    if (secret === '') continue
    const buf = Buffer.from(secret)
    all.add(secret)
    all.add(buf.toString('base64'))
    all.add(buf.toString('base64url'))
    all.add(encodeURIComponent(secret))
  }
  return [...all].sort((a, b) => b.length - a.length)
}

/** All check output of one ticket shares this many characters, so the state comment stays well under GitHub's limit. */
const CHECK_OUTPUT_BUDGET = 12000
const MIN_CHECK_OUTPUT = 200

/** Replaces each non-empty secret with '[redacted]', then keeps the last `max` characters. */
export function cleanOutput(output: string, secrets: string[], max = MAX_OUTPUT): string {
  let text = output
  for (const form of forms(secrets)) text = text.split(form).join('[redacted]')
  return text.length > max ? CUT_MARK + text.slice(-max) : text
}

/** The most output stored for each check of a ticket with `checkCount` checks. */
export function checkOutputMax(checkCount: number): number {
  return Math.max(MIN_CHECK_OUTPUT, Math.min(MAX_OUTPUT, Math.floor(CHECK_OUTPUT_BUDGET / checkCount)))
}
