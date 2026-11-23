import type { StateName, TicketState } from './types.js'

export const STATE_NAMES = [
  'queued', 'triaged', 'awaiting_criteria', 'criteria_ready', 'env_ready',
  'checks_failing', 'building', 'verified', 'pr_open', 'changes_requested',
  'skipped', 'not_reproducible', 'needs_human', 'fix_failed',
  'merged', 'rejected',
] as const satisfies readonly StateName[]

export const DURABLE: readonly StateName[] = [
  'queued', 'awaiting_criteria', 'criteria_ready', 'pr_open', 'changes_requested',
  'skipped', 'not_reproducible', 'needs_human', 'fix_failed',
  'merged', 'rejected',
]

/** `merged` and `rejected` are how a pull request ends; like the others they wait for a retry label. */
export const ENDS: readonly StateName[] = ['skipped', 'not_reproducible', 'needs_human', 'fix_failed', 'merged', 'rejected']

const MOVES: Record<StateName, StateName[]> = {
  queued: ['triaged'],
  triaged: ['skipped', 'criteria_ready', 'awaiting_criteria'],
  awaiting_criteria: ['criteria_ready'],
  criteria_ready: ['env_ready'],
  env_ready: ['checks_failing', 'not_reproducible', 'needs_human'],
  checks_failing: ['building'],
  building: ['verified', 'fix_failed', 'needs_human'],
  verified: ['pr_open'],
  pr_open: ['merged', 'rejected', 'changes_requested'],
  changes_requested: ['building', 'merged', 'rejected'],
  skipped: [],
  not_reproducible: [],
  needs_human: [],
  fix_failed: [],
  merged: [],
  rejected: [],
}

export function isDurable(s: StateName): boolean {
  return DURABLE.includes(s)
}

export function canTransition(from: StateName, to: StateName): boolean {
  if (to === 'needs_human') return true
  if (to === 'queued' && (from === 'pr_open' || from === 'changes_requested' || ENDS.includes(from))) return true
  return Object.hasOwn(MOVES, from) && MOVES[from].includes(to)
}

export function newState(rumba: string, _now: Date): TicketState {
  return {
    version: 1,
    rumba,
    state: 'queued',
    lastDurable: 'queued',
    criteria: [],
    checks: [],
    checkHashes: {},
    fixAttempts: 0,
    errorCount: 0,
    history: [],
  }
}

/**
 * True when `later` carries on from `earlier`: its history holds all of earlier's moves, and
 * perhaps more. False when another run moved the ticket on from where `later` was made.
 */
export function carriesOn(earlier: TicketState, later: TicketState): boolean {
  const n = earlier.history.length
  if (n === 0) return true
  const a = earlier.history[n - 1]!
  const b = later.history[n - 1]
  return b !== undefined && a.state === b.state && a.at === b.at && a.note === b.note
}

export function transition(s: TicketState, to: StateName, now: Date, note?: string): TicketState {
  if (!canTransition(s.state, to)) throw new Error(`Illegal move from ${s.state} to ${to}`)
  const entry = note === undefined ? { state: to, at: now.toISOString() } : { state: to, at: now.toISOString(), note }
  return {
    ...structuredClone(s),
    state: to,
    lastDurable: isDurable(to) ? to : s.lastDurable,
    history: [...structuredClone(s.history), entry],
  }
}
