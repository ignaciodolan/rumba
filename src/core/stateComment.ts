import { z } from 'zod'
import { DURABLE } from './states.js'
import { isValidRumbaName } from './labels.js'
import type { StateName, TicketState } from './types.js'

export const STATE_MARKER = 'rumba-state-v1'

const STATE_NAMES = [
  'queued', 'triaged', 'awaiting_criteria', 'criteria_ready', 'env_ready',
  'checks_failing', 'building', 'verified', 'pr_open',
  'skipped', 'not_reproducible', 'needs_human', 'fix_failed',
] as const satisfies readonly StateName[]
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    if ((parsed as { marker?: unknown }).marker !== STATE_MARKER) continue
    const result = ticketState.safeParse(parsed)
    return result.success ? (result.data as TicketState) : null
  }
  return null
}
