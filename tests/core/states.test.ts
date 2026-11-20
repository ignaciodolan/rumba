import { describe, expect, it } from 'vitest'
import { DURABLE, ENDS, canTransition, isDurable, newState, transition } from '../../src/core/states.js'

const t0 = new Date('2026-01-01T00:00:00.000Z')

describe('states', () => {
  it('walks the happy path', () => {
    let s = newState('hub', t0)
    for (const to of ['triaged', 'criteria_ready', 'env_ready', 'checks_failing', 'building', 'verified', 'pr_open'] as const) s = transition(s, to, t0)
    expect(s.state).toBe('pr_open')
    expect(s.lastDurable).toBe('pr_open')
    expect(s.history.map(h => h.state)).toEqual(['triaged', 'criteria_ready', 'env_ready', 'checks_failing', 'building', 'verified', 'pr_open'])
    expect(s.history[0]?.at).toBe(t0.toISOString())
  })
  it('keeps lastDurable while in transient states', () => {
    const s = transition(transition(transition(newState('hub', t0), 'triaged', t0), 'criteria_ready', t0), 'env_ready', t0)
    expect(s.lastDurable).toBe('criteria_ready')
  })
  it('rejects illegal moves', () => {
    expect(() => transition(newState('hub', t0), 'verified', t0)).toThrow(/queued.*verified/)
  })
  it('allows needs_human from anywhere and retry from ends', () => {
    const stuck = transition(newState('hub', t0), 'needs_human', t0, 'time budget exceeded')
    expect(stuck.history.at(-1)?.note).toBe('time budget exceeded')
    expect(transition(stuck, 'queued', t0).state).toBe('queued')
  })
  it('starts queued with empty counters and history', () => {
    const s = newState('hub', t0)
    expect(s).toMatchObject({ version: 1, rumba: 'hub', state: 'queued', lastDurable: 'queued', fixAttempts: 0, errorCount: 0, criteria: [], checks: [], checkHashes: {}, history: [] })
  })
  it('does not mutate its input', () => {
    const s = newState('hub', t0)
    const next = transition(s, 'triaged', t0)
    expect(s.history).toEqual([])
    expect(s.state).toBe('queued')
    expect(next.history).toHaveLength(1)
    expect(next).not.toBe(s)
  })
  it('classifies durable states and ends', () => {
    expect(DURABLE).toEqual(['queued', 'awaiting_criteria', 'criteria_ready', 'pr_open', 'skipped', 'not_reproducible', 'needs_human', 'fix_failed'])
    expect(ENDS).toEqual(['skipped', 'not_reproducible', 'needs_human', 'fix_failed'])
    expect(isDurable('building')).toBe(false)
    expect(isDurable('pr_open')).toBe(true)
  })
  it('allows retry from pr_open and ends, not from mid-flight', () => {
    expect(canTransition('pr_open', 'queued')).toBe(true)
    expect(canTransition('fix_failed', 'queued')).toBe(true)
    expect(canTransition('building', 'queued')).toBe(false)
    expect(canTransition('building', 'needs_human')).toBe(true)
  })
})
