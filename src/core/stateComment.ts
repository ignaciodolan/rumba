import { z } from 'zod'
import { DURABLE, STATE_NAMES } from './states.js'
import { isValidRumbaName } from './labels.js'
import type { TicketState } from './types.js'

export const STATE_MARKER = 'rumba-state-v1'

const stateName = z.enum(STATE_NAMES)
const durableState = z.enum(STATE_NAMES).refine(s => DURABLE.includes(s))
const count = z.number().int().nonnegative()
const checkResult = z.object({ criterionId: z.string(), passed: z.boolean(), exitCode: z.number(), output: z.string() })

// Tracker comments are untrusted input, so the decoded state is validated strictly.
const ticketState = z.object({
  version: z.literal(1),
  rumba: z.string().refine(isValidRumbaName),
  state: stateName,
  lastDurable: durableState,
  kind: z.enum(['bug', 'feature']).optional(),
  criteria: z.array(z.object({ id: z.string(), text: z.string(), checkable: z.boolean() })),
  checks: z.array(z.object({ criterionId: z.string(), command: z.string(), files: z.array(z.string()) })),
  checkHashes: z.record(z.string(), z.string()),
  fixAttempts: count,
  errorCount: count,
  branch: z.string().optional(),
  baseSha: z.string().optional(),
  checksSha: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  before: z.array(checkResult).optional(),
  after: z.array(checkResult).optional(),
  lease: z.object({ runId: z.string(), at: z.string() }).optional(),
  history: z.array(z.object({ state: stateName, at: z.string(), note: z.string().optional() })),
})

/** Well under GitHub's 65,536-character limit on a comment. */
export const MAX_STATE_COMMENT = 60000
const OUTPUT_DROPPED = '[output dropped: state too large]'

function encode(s: TicketState): string {
  // Escape backticks so no value in the state can close the fence early.
  const json = JSON.stringify({ marker: STATE_MARKER, ...s }, null, 2).replaceAll('`', '\\u0060')
  return `Rumba \`${s.rumba}\` state: ${s.state}\n\n\`\`\`json\n${json}\n\`\`\`\n`
}

/**
 * The state comment, at most MAX_STATE_COMMENT characters. When it would be longer, the check
 * output is left out of it; when it is still too long, this throws. `s` is never changed.
 */
export function encodeStateComment(s: TicketState): string {
  const full = encode(s)
  if (full.length <= MAX_STATE_COMMENT) return full
  const drop = (results: TicketState['before']) => results?.map((r) => ({ ...r, output: OUTPUT_DROPPED }))
  const slim: TicketState = { ...s }
  if (s.before !== undefined) slim.before = drop(s.before)
  if (s.after !== undefined) slim.after = drop(s.after)
  const body = encode(slim)
  if (body.length <= MAX_STATE_COMMENT) return body
  throw new Error(`The state is too large to store: ${body.length} characters, over the limit of ${MAX_STATE_COMMENT}.`)
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    if ((parsed as { marker?: unknown }).marker !== STATE_MARKER) continue
    const result = ticketState.safeParse(parsed)
    return result.success ? (result.data as TicketState) : null
  }
  return null
}
