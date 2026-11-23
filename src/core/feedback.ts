import type { FeedbackItem } from '../ports/codeHost.js'
import { cleanOutput } from './redact.js'
import type { Feedback } from './types.js'

export const MAX_FEEDBACK = 20
export const MAX_FEEDBACK_TEXT = 2000

export interface Selection {
  /** True when a writer asked for changes in a review. The revise label is the caller's to add. */
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
 * Picks the feedback Rumba may act on. Only a writer who is not Rumba's own account counts: text from anyone
 * else could steer the agent, so it is dropped here and never reaches the state, the tracker or an error.
 */
export function selectFeedback(items: FeedbackItem[], secrets: string[]): Selection {
  const kept = items.filter((i) => i.canWrite && !i.self)
  const requested = kept.some((i) => i.kind === 'review' && i.reviewState === 'changes_requested')
  const newest = kept
    .filter(worthStoring)
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
