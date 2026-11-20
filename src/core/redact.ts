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

/** Replaces each non-empty secret, and its encoded forms, with '[redacted]'. Cuts nothing. */
export function redact(text: string, secrets: string[]): string {
  let out = text
  for (const form of forms(secrets)) out = out.split(form).join('[redacted]')
  return out
}

/** A copy of `value` with every string in it, at any depth, passed through `redact`. */
export function redactDeep<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redact(value, secrets) as T
  if (Array.isArray(value)) return value.map((v: unknown) => redactDeep(v, secrets)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, secrets)])) as T
  }
  return value
}

/** Replaces each non-empty secret with '[redacted]', then keeps the last `max` characters. */
export function cleanOutput(output: string, secrets: string[], max = MAX_OUTPUT): string {
  const text = redact(output, secrets)
  return text.length > max ? CUT_MARK + text.slice(-max) : text
}

/** The most output stored for each check of a ticket with `checkCount` checks. */
export function checkOutputMax(checkCount: number): number {
  return Math.max(MIN_CHECK_OUTPUT, Math.min(MAX_OUTPUT, Math.floor(CHECK_OUTPUT_BUDGET / checkCount)))
}
