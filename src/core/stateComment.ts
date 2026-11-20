import type { TicketState } from './types.js'

export const STATE_MARKER = 'rumba-state-v1'

export function encodeStateComment(s: TicketState): string {
  // Escape backticks so no value in the state can close the fence early.
  const json = JSON.stringify({ marker: STATE_MARKER, ...s }, null, 2).replaceAll('`', '\\u0060')
  return `Rumba \`${s.rumba}\` state: ${s.state}\n\n\`\`\`json\n${json}\n\`\`\`\n`
}

export function decodeStateComment(body: string): TicketState | null {
  if (typeof body !== 'string') return null
  for (const m of body.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[1] ?? '')
    } catch {
      continue
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as { marker?: unknown }).marker === STATE_MARKER) {
      const { marker: _marker, ...state } = parsed as Record<string, unknown>
      return state as unknown as TicketState
    }
  }
  return null
}
