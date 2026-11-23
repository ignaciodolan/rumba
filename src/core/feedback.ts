import type { FeedbackItem } from '../ports/codeHost.js'
import { cleanOutput } from './redact.js'
import type { Feedback } from './types.js'

export const MAX_FEEDBACK = 20
export const MAX_FEEDBACK_TEXT = 2000

export interface Selection {
  /**
   * True when a writer asked for changes: their latest decision is a changes-requested review, or they left a line
   * comment or a commented review with a body that they have not approved after. Pull request comments alone are
   * discussion and do not count. The revise label is the caller's to add.
   */
  requested: boolean
  feedback: Feedback[]
}

/** An approval, or a bare "commented" review, says nothing worth passing on. */
function worthStoring(item: FeedbackItem): boolean {
  if (item.kind !== 'review') return true
  if (item.reviewState === 'approved') return false
  return item.reviewState === 'changes_requested' || item.text.trim() !== ''
}

/**
 * A line comment, or a commented review with a body, asks for something unless its author approved at or after it (an approval's own line comments share its time):
 * GitHub's "Comment" review is how many reviewers ask for changes, and a later approval answers it.
 */
function asksForChange(i: FeedbackItem, kept: FeedbackItem[]): boolean {
  const asks = i.kind === 'line' || (i.kind === 'review' && i.reviewState === 'commented' && i.text.trim() !== '')
  if (!asks) return false
  return !kept.some((a) => a.kind === 'review' && a.reviewState === 'approved' && a.author === i.author && Date.parse(a.at) >= Date.parse(i.at))
}

/**
 * Picks the feedback Rumba may act on. Only a writer's counts, and never Rumba's own comments: text from anyone
 * else could steer the agent, so it is dropped here and never reaches the state, the tracker or an error.
 */
export function selectFeedback(items: FeedbackItem[], secrets: string[]): Selection {
  const kept = items.filter((i) => i.canWrite && !i.self)
  // GitHub counts only each reviewer's latest decision, so an earlier request that was later approved
  // asks for nothing and its body is not passed on.
  const latest = new Map<string, FeedbackItem>()
  for (const i of kept) {
    if (i.kind !== 'review' || (i.reviewState !== 'changes_requested' && i.reviewState !== 'approved')) continue
    const seen = latest.get(i.author)
    if (seen === undefined || Date.parse(i.at) >= Date.parse(seen.at)) latest.set(i.author, i)
  }
  const superseded = (i: FeedbackItem): boolean =>
    i.kind === 'review' && i.reviewState === 'changes_requested' && latest.get(i.author) !== i
  const requested = [...latest.values()].some((i) => i.reviewState === 'changes_requested') || kept.some((i) => asksForChange(i, kept))
  const newest = kept
    .filter((i) => worthStoring(i) && !superseded(i))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_FEEDBACK)
  const feedback = newest.map((i): Feedback => ({
    kind: i.kind,
    author: i.author,
    url: i.url,
    at: i.at,
    text: cleanOutput(i.text, secrets, MAX_FEEDBACK_TEXT),
    ...(i.path === undefined ? {} : { path: i.path }),
    ...(i.line === undefined ? {} : { line: i.line }),
  }))
  return { requested, feedback }
}
