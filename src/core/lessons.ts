import type { RumbaConfig } from '../config/load.js'
import type { AgentResult } from '../ports/agent.js'
import type { Deps } from '../ports/deps.js'
import { timeLeft } from './budget.js'
import { redact } from './redact.js'
import { cleanupQuietly } from './steps/teardown.js'
import type { Feedback, LessonRecord, Ticket, TicketState } from './types.js'

/** How many lesson records a ticket keeps, the latest. */
export const LESSONS_KEPT = 10
/** The most characters of a lesson record's reason. */
export const LESSON_REASON_MAX = 500

const MAX_LINES = 3
const MAX_LINE = 200
/** A lesson that shares this many characters in a row with a feedback text quotes it. */
const QUOTE_RUN = 40
const QUOTED = 'the lesson quoted the feedback'
const EMPTY = 'the lesson was empty once cleaned'
const NO_FEEDBACK = 'There was no feedback to learn from.'

// Control characters, and the Unicode line and paragraph separators, which also break a line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

type Distilled = Extract<AgentResult, { kind: 'distill-lesson' }>

/**
 * The agent's lesson as Rumba writes it: each line redacted, its control characters made
 * spaces, trimmed and cut to 200 characters; empty lines dropped; at most three. Refused when
 * nothing is left, or when it quotes the feedback (40 characters in a row of any feedback
 * text, ignoring case and spacing): the lesson is read by every later ticket's agent, so
 * reviewer text must not reach it word for word.
 */
export function cleanLesson(lines: string[], feedback: Feedback[], secrets: string[]): { lines: string[] } | { refused: string } {
  const kept = lines
    .map((l) => redact(l, secrets).replace(CONTROL, ' ').trim().slice(0, MAX_LINE).trimEnd())
    .filter((l) => l !== '')
    .slice(0, MAX_LINES)
  if (kept.length === 0) return { refused: EMPTY }
  if (quotes(kept, feedback, secrets)) return { refused: QUOTED }
  return { lines: kept }
}

function normalize(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** True when the lesson, its lines read as one text, shares QUOTE_RUN characters in a row with a feedback text as cleaned. */
function quotes(lines: string[], feedback: Feedback[], secrets: string[]): boolean {
  const lesson = normalize(lines.join(' '))
  const texts = feedback.map((f) => normalize(redact(f.text, secrets))).filter((t) => t.length >= QUOTE_RUN)
  for (let i = 0; i + QUOTE_RUN <= lesson.length; i++) {
    const run = lesson.slice(i, i + QUOTE_RUN)
    if (texts.some((t) => t.includes(run))) return true
  }
  return false
}

/** The lesson as one list item of lessons.md, linking to the pull request it came from. No trailing newline. */
export function lessonEntry(lines: string[], url: string): string {
  const [first, ...rest] = lines
  return [`- ${first ?? ''}`, ...rest.map((l) => `  ${l}`), `  From ${url}`].join('\n')
}

/**
 * The lessons file with `entry` added at its end, after exactly one blank line, ending in a
 * newline. `current` null: the file is missing. Existing lines are kept as they are; only
 * blank lines at the end are dropped.
 */
export function appendLesson(current: string | null, entry: string): string {
  const lines = (current ?? '').split('\n')
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  return lines.length === 0 ? `${entry}\n` : `${lines.join('\n')}\n\n${entry}\n`
}

/** The state with `record` added, keeping the latest LESSONS_KEPT. */
export function withLesson(state: TicketState, record: LessonRecord): TicketState {
  return { ...state, lessons: [...(state.lessons ?? []), record].slice(-LESSONS_KEPT) }
}

export function lessonsPath(rumba: string): string {
  return `.rumba/${rumba}/lessons.md`
}

export interface LearnOptions {
  /** The feedback to learn from, as selected and cleaned for the ticket. */
  feedback: Feedback[]
  /** The pull request the feedback was written on; the entry links to it. */
  url: string
  /** The branch the lesson is committed on. */
  branch: string
  /** Make the branch again from the default branch (a lesson pull request of its own) instead of checking it out. */
  fresh?: boolean
  /** How the branch is pushed once the lesson is committed. */
  push: { force: boolean }
}

/**
 * Asks the agent whether the feedback holds a general rule and, when it gives one that Rumba
 * accepts, appends it to the rumba's lessons.md on `branch`, commits that file alone and pushes
 * it. Returns what to record on the ticket. Never throws: a lesson is a side matter, and its
 * failure must not undo the round or the outcome that asked for it.
 */
export async function learn(deps: Deps, rumba: RumbaConfig, ticket: Ticket, _state: TicketState, opts: LearnOptions): Promise<LessonRecord> {
  const at = deps.clock().toISOString()
  if (opts.feedback.length === 0) return { at, status: 'none', reason: NO_FEEDBACK }
  try {
    const answer = await distill(deps, rumba, ticket, opts.feedback)
    if (answer.none !== undefined) return { at, status: 'none', reason: bounded(answer.none, deps.secrets) }
    const cleaned = cleanLesson(answer.lesson ?? [], opts.feedback, deps.secrets)
    if ('refused' in cleaned) return { at, status: 'refused', reason: cleaned.refused }
    const commit = await commitLesson(deps, rumba, ticket, lessonEntry(cleaned.lines, opts.url), opts)
    return { at, status: 'added', commit }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return { at, status: 'failed', reason: bounded(`The lesson could not be drawn: ${message}`, deps.secrets) }
  }
}

/** The agent's answer, from a checkout of the default branch that is removed after: nothing it writes there is kept. */
async function distill(deps: Deps, rumba: RumbaConfig, ticket: Ticket, feedback: Feedback[]): Promise<Distilled> {
  const { workdir } = await deps.workspace.prepare(`rumba/${rumba.name}/distill-${ticket.id}`, { fresh: true })
  try {
    const result = await deps.agent.run({
      kind: 'distill-lesson', ticket, context: rumba.context, environmentKind: rumba.environment.kind, feedback, timeoutMs: timeLeft(deps),
    }, workdir)
    if (result.kind !== 'distill-lesson') throw new Error(`Agent returned ${result.kind} for a distill-lesson task`)
    return result
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/**
 * Commits lessons.md, with `entry` appended, on the branch and pushes it. The file is read from
 * the branch's commit and written with commitFile, never through the checkout. A refused push
 * takes the commit off the local branch, so it holds what the remote does.
 */
async function commitLesson(deps: Deps, rumba: RumbaConfig, ticket: Ticket, entry: string, opts: LearnOptions): Promise<string> {
  const file = lessonsPath(rumba.name)
  const { workdir } = await deps.workspace.prepare(opts.branch, { fresh: opts.fresh ?? false })
  try {
    const head = await deps.workspace.head(workdir)
    const current = await deps.workspace.readFileAt(workdir, head, file)
    const sha = await deps.workspace.commitFile(workdir, file, appendLesson(current, entry), `docs: lesson from review of ${ticket.ref}`)
    try {
      await deps.codeHost.pushBranch(workdir, opts.branch, opts.push)
    } catch (e) {
      await deps.workspace.reset(workdir, head).catch(() => undefined)
      throw e
    }
    return sha
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/** Redacted and cut to LESSON_REASON_MAX characters, keeping the start, which says what went wrong. */
function bounded(text: string, secrets: string[]): string {
  const clean = redact(text, secrets).replace(CONTROL, ' ').trim()
  return clean.length > LESSON_REASON_MAX ? `${clean.slice(0, LESSON_REASON_MAX - 1)}…` : clean
}
