import type { Deps } from '../ports/deps.js'

/** No call gets less than this, because a limit of 0 means no limit to some tools. */
const MIN_CALL_MS = 1000

/**
 * The milliseconds the ticket has left, for a call that must not outlast it. Undefined when no
 * budget is running (a step called outside the engine).
 */
export function timeLeft(deps: Deps): number | undefined {
  if (deps.deadline === undefined) return undefined
  return Math.max(MIN_CALL_MS, deps.deadline.getTime() - deps.clock().getTime())
}

/** Extra time a lease is held past the budget: the environment is taken down after a ticket stops. */
export const LEASE_MARGIN_MINUTES = 5
