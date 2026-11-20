export const MAX_OUTPUT = 4000

const CUT_MARK = '[…cut]\n'

/** Replaces each non-empty secret with '[redacted]', then keeps the last MAX_OUTPUT characters. */
export function cleanOutput(output: string, secrets: string[]): string {
  let text = output
  for (const secret of secrets) {
    if (secret !== '') text = text.split(secret).join('[redacted]')
  }
  return text.length > MAX_OUTPUT ? CUT_MARK + text.slice(-MAX_OUTPUT) : text
}
