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

/** Replaces each non-empty secret with '[redacted]', then keeps the last MAX_OUTPUT characters. */
export function cleanOutput(output: string, secrets: string[]): string {
  let text = output
  for (const form of forms(secrets)) text = text.split(form).join('[redacted]')
  return text.length > MAX_OUTPUT ? CUT_MARK + text.slice(-MAX_OUTPUT) : text
}
