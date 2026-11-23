import { describe, expect, it } from 'vitest'
import { DURABLE, ENDS, STATE_NAMES, canTransition, isDurable, newState, transition } from '../../src/core/states.js'

const t0 = new Date('2026-01-01T00:00:00.000Z')

describe('states', () => {
  it('walks the happy path', () => {
    let s = newState('shop', t0)
    for (const to of ['triaged', 'criteria_ready', 'env_ready', 'checks_failing', 'building', 'verified', 'pr_open'] as const) s = transition(s, to, t0)
    expect(s.state).toBe('pr_open')
    expect(s.lastDurable).toBe('pr_open')
    expect(s.history.map(h => h.state)).toEqual(['triaged', 'criteria_ready', 'env_ready', 'checks_failing', 'building', 'verified', 'pr_open'])
    expect(s.history[0]?.at).toBe(t0.toISOString())
  })
  it('keeps lastDurable while in transient states', () => {
    const s = transition(transition(transition(newState('shop', t0), 'triaged', t0), 'criteria_ready', t0), 'env_ready', t0)
    expect(s.lastDurable).toBe('criteria_ready')
  })
  it('rejects illegal moves', () => {
    expect(() => transition(newState('shop', t0), 'verified', t0)).toThrow(/queued.*verified/)
  })
  it('allows needs_human from anywhere and retry from ends', () => {
    const stuck = transition(newState('shop', t0), 'needs_human', t0, 'time budget exceeded')
    expect(stuck.history.at(-1)?.note).toBe('time budget exceeded')
    expect(transition(stuck, 'queued', t0).state).toBe('queued')
  })
  it('starts queued with empty counters and history', () => {
    const s = newState('shop', t0)
    expect(s).toMatchObject({ version: 1, rumba: 'shop', state: 'queued', lastDurable: 'queued', fixAttempts: 0, errorCount: 0, criteria: [], checks: [], checkHashes: {}, history: [] })
  })
  it('does not mutate its input', () => {
    const s = newState('shop', t0)
    const next = transition(s, 'triaged', t0)
    expect(s.history).toEqual([])
    expect(s.state).toBe('queued')
    expect(next.history).toHaveLength(1)
    expect(next).not.toBe(s)
  })
  it('classifies durable states and ends', () => {
    expect(DURABLE).toEqual(['queued', 'awaiting_criteria', 'criteria_ready', 'pr_open', 'changes_requested', 'skipped', 'not_reproducible', 'needs_human', 'fix_failed', 'merged', 'rejected'])
    expect(ENDS).toEqual(['skipped', 'not_reproducible', 'needs_human', 'fix_failed', 'merged', 'rejected'])
    expect(isDurable('building')).toBe(false)
    expect(isDurable('pr_open')).toBe(true)
  })
  it('allows retry from pr_open and ends, not from mid-flight', () => {
    expect(canTransition('pr_open', 'queued')).toBe(true)
    expect(canTransition('fix_failed', 'queued')).toBe(true)
    expect(canTransition('building', 'queued')).toBe(false)
    expect(canTransition('building', 'needs_human')).toBe(true)
  })
  it('parks a pull request in changes_requested: durable, not an end, left only by needs_human or retry', () => {
    expect(STATE_NAMES.indexOf('changes_requested')).toBe(STATE_NAMES.indexOf('pr_open') + 1)
    expect(isDurable('changes_requested')).toBe(true)
    expect(ENDS).not.toContain('changes_requested')
    expect(canTransition('pr_open', 'changes_requested')).toBe(true)
    expect(canTransition('changes_requested', 'queued')).toBe(true)
    expect(canTransition('changes_requested', 'needs_human')).toBe(true)
    expect(canTransition('changes_requested', 'pr_open')).toBe(false)
    expect(canTransition('changes_requested', 'building')).toBe(true)
    for (const to of ['merged', 'rejected'] as const) expect(canTransition('changes_requested', to)).toBe(true)
    expect(canTransition('verified', 'changes_requested')).toBe(false)
  })
  it('lets pr_open end as merged or rejected, and nothing leave them but a retry', () => {
    expect(canTransition('pr_open', 'merged')).toBe(true)
    expect(canTransition('pr_open', 'rejected')).toBe(true)
    expect(canTransition('merged', 'pr_open')).toBe(false)
    expect(canTransition('rejected', 'building')).toBe(false)
    expect(canTransition('merged', 'queued')).toBe(true)
    expect(canTransition('rejected', 'queued')).toBe(true)
    expect(canTransition('verified', 'merged')).toBe(false)
  })
  it('keeps merged and rejected as durable end states', () => {
    for (const s of ['merged', 'rejected'] as const) {
      expect(isDurable(s)).toBe(true)
      expect(ENDS).toContain(s)
      expect(transition({ ...newState('shop', t0), state: 'pr_open', lastDurable: 'pr_open' }, s, t0).lastDurable).toBe(s)
    }
  })
  it('returns false for values that are not states', () => {
    expect(canTransition('toString' as never, 'triaged')).toBe(false)
    expect(canTransition('__proto__' as never, 'triaged')).toBe(false)
  })
})
