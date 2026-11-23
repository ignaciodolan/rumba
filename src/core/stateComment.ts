import { z } from 'zod'
import { DURABLE, STATE_NAMES } from './states.js'
import { isValidRumbaName } from './labels.js'
import { LESSON_REASON_MAX, LESSONS_KEPT } from './lessonLimits.js'
import type { TicketState } from './types.js'

export const STATE_MARKER = 'rumba-state-v1'

const stateName = z.enum(STATE_NAMES)
const durableState = z.enum(STATE_NAMES).refine(s => DURABLE.includes(s))
const count = z.number().int().nonnegative()
const checkResult = z.object({ criterionId: z.string(), passed: z.boolean(), exitCode: z.number(), output: z.string(), infrastructure: z.string().optional() })
const attempt = z.object({
  n: count,
  outcome: z.enum(['verified', 'checks-failed', 'project-tests-failed', 'guard', 'no-change', 'infrastructure']),
  checks: z.array(z.object({ criterionId: z.string(), passed: z.boolean(), exitCode: z.number() })),
  projectTests: z.enum(['passed', 'failed', 'infrastructure', 'not-run']),
  note: z.string().optional(),
  tail: z.string(),
})

const check = z.object({
  criterionId: z.string(), command: z.string(), files: z.array(z.string()), changedAfterReview: z.boolean().optional(), changeAskedIn: z.string().optional(),
})
const feedback = z.object({
  kind: z.enum(['review', 'line', 'comment']),
  author: z.string(),
  url: z.string(),
  at: z.string(),
  text: z.string(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
}).strict()
const relocation = z.object({
  status: z.enum(['started', 'relocated', 'rejected']),
  from: z.string(),
  reason: z.string().optional(),
  sha: z.string().optional(),
  moves: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  original: z.array(check).optional(),
  before: z.array(checkResult).optional(),
})
// Bounded, so the lessons alone can never push the comment over its limit.
const lesson = z.object({
  at: z.string(),
  status: z.enum(['added', 'none', 'refused', 'failed']),
  reason: z.string().max(LESSON_REASON_MAX).optional(),
  commit: z.string().optional(),
  pullRequestUrl: z.string().optional(),
}).strict()

// Tracker comments are untrusted input, so the decoded state is validated strictly.
const ticketState = z.object({
  version: z.literal(1),
  rumba: z.string().refine(isValidRumbaName),
  state: stateName,
  lastDurable: durableState,
  kind: z.enum(['bug', 'feature']).optional(),
  criteria: z.array(z.object({ id: z.string(), text: z.string(), checkable: z.boolean(), reason: z.string().optional() })),
  checks: z.array(check),
  checkHashes: z.record(z.string(), z.string()),
  fixAttempts: count,
  errorCount: count,
  branch: z.string().optional(),
  baseSha: z.string().optional(),
  checksSha: z.string().optional(),
  pullRequestUrl: z.string().optional(),
  pushedAt: z.string().optional(),
  answeredAt: z.string().optional(),
  reviewRounds: count.optional(),
  feedback: z.array(feedback).optional(),
  before: z.array(checkResult).optional(),
  after: z.array(checkResult).optional(),
  attempts: z.array(attempt).optional(),
  fixSummary: z.string().optional(),
  relocation: relocation.optional(),
  lessons: z.array(lesson).max(LESSONS_KEPT).optional(),
  lease: z.object({ runId: z.string(), at: z.string() }).optional(),
  history: z.array(z.object({ state: stateName, at: z.string(), note: z.string().optional() })),
})

/** Well under GitHub's 65,536-character limit on a comment. */
export const MAX_STATE_COMMENT = 60000
const OUTPUT_DROPPED = '[output dropped: state too large]'

function cutStart(text: string, keep: number): string {
  return text.length <= keep ? text : text.slice(text.length - keep)
}

function cutEnd(text: string, keep: number): string {
  return text.length <= keep ? text : text.slice(0, keep)
}

function encode(s: TicketState): string {
  // Escape backticks so no value in the state can close the fence early.
  const json = JSON.stringify({ marker: STATE_MARKER, ...s }, null, 2).replaceAll('`', '\\u0060')
  return `Rumba \`${s.rumba}\` state: ${s.state}\n\n\`\`\`json\n${json}\n\`\`\`\n`
}

/**
 * The state comment, at most MAX_STATE_COMMENT characters. When it would be longer, the check
 * output is left out of it, then the feedback texts are cut, then the lesson reasons; when it is
 * still too long, this throws. `s` is never changed.
 */
export function encodeStateComment(s: TicketState): string {
  const full = encode(s)
  if (full.length <= MAX_STATE_COMMENT) return full
  const drop = (results: TicketState['before']) => results?.map((r) => ({ ...r, output: OUTPUT_DROPPED }))
  const slim: TicketState = { ...s }
  if (s.before !== undefined) slim.before = drop(s.before)
  if (s.after !== undefined) slim.after = drop(s.after)
  if (s.relocation?.before !== undefined) slim.relocation = { ...s.relocation, before: drop(s.relocation.before) }
  if (s.attempts !== undefined) slim.attempts = s.attempts.map((a) => ({ ...a, tail: OUTPUT_DROPPED }))
  const body = encode(slim)
  if (body.length <= MAX_STATE_COMMENT) return body
  return fitTexts(slim, body)
}

/** The first cut keeps this many characters of each feedback text; each further one halves it. */
const FEEDBACK_KEPT = 2000
const FEEDBACK_KEPT_MIN = 100

/** The first cut keeps this many characters of each lesson reason; each further one halves it. */
const REASON_KEPT = 250
const REASON_KEPT_MIN = 25

/**
 * Cuts every feedback text to its end, shorter each time, until the comment fits; then, with the
 * feedback at its shortest, every lesson reason to its start the same way. Throws when it never fits.
 */
function fitTexts(slim: TicketState, tooLarge: string): string {
  let body = tooLarge
  let cut = slim
  if (slim.feedback !== undefined) {
    for (let keep = FEEDBACK_KEPT; keep >= FEEDBACK_KEPT_MIN; keep = Math.floor(keep / 2)) {
      // The end of a text is kept: a long review usually closes with what it asks for.
      cut = { ...slim, feedback: slim.feedback.map((f) => ({ ...f, text: cutStart(f.text, keep) })) }
      body = encode(cut)
      if (body.length <= MAX_STATE_COMMENT) return body
    }
  }
  if (slim.lessons !== undefined) {
    for (let keep = REASON_KEPT; keep >= REASON_KEPT_MIN; keep = Math.floor(keep / 2)) {
      // The start of a reason is kept: it says what went wrong.
      body = encode({ ...cut, lessons: slim.lessons.map((l) => l.reason === undefined ? l : { ...l, reason: cutEnd(l.reason, keep) }) })
      if (body.length <= MAX_STATE_COMMENT) return body
    }
  }
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
