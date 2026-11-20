import { describe, expect, it } from 'vitest'
import { defaultLabels, stateLabel } from '../core/labels.js'
import { newState, transition } from '../core/states.js'
import type { Ticket, TicketState } from '../core/types.js'
import type { Tracker } from '../ports/tracker.js'

export interface TrackerUnderTest {
  /** Built with defaultLabels('hub'). */
  tracker: Tracker
  seedTicket(labels: string[], opts?: { closed?: boolean }): Promise<Ticket>
  /** Bodies of the comments on the ticket, oldest first. */
  comments(t: Ticket): Promise<string[]>
}

const LABELS = defaultLabels('hub')
const NOW = new Date('2026-01-01T00:00:00Z')

function triaged(): TicketState {
  const s = transition(newState('hub', NOW), 'triaged', NOW, 'looks workable')
  return { ...s, kind: 'bug', criteria: [{ id: 'c1', text: 'Saving works', checkable: true }], errorCount: 1 }
}

function stateLabels(labels: string[]): string[] {
  return labels.filter((l) => l.startsWith(LABELS.statePrefix))
}

/** Registers the tests every Tracker must pass. */
export function trackerContract(name: string, make: () => Promise<TrackerUnderTest>): void {
  describe(`Tracker contract: ${name}`, () => {
    it('reads back the state it wrote', async () => {
      const u = await make()
      const { tracker } = u
      const t = await u.seedTicket([LABELS.optIn])
      await tracker.writeState(t, triaged())
      expect(await tracker.readState(t)).toEqual(triaged())
    })

    it('reads no state from a ticket that has none', async () => {
      const u = await make()
      const { tracker } = u
      expect(await tracker.readState(await u.seedTicket([LABELS.optIn]))).toBeNull()
    })

    it('edits the state comment on a second write instead of adding one', async () => {
      const u = await make()
      const { tracker } = u
      const t = await u.seedTicket([LABELS.optIn])
      await tracker.writeState(t, newState('hub', NOW))
      const after1 = (await u.comments(t)).length
      await tracker.writeState(t, triaged())
      expect(await u.comments(t)).toHaveLength(after1)
      expect(await tracker.readState(t)).toEqual(triaged())
    })

    it('leaves exactly one state label after two writes', async () => {
      const u = await make()
      const { tracker } = u
      const t = await u.seedTicket([LABELS.optIn, 'bug'])
      await tracker.writeState(t, newState('hub', NOW))
      await tracker.writeState(t, triaged())
      const want = stateLabel(LABELS, 'triaged')
      expect(stateLabels(t.labels)).toEqual([want])
      const fresh = await tracker.getTicket(t.id)
      expect(stateLabels(fresh.labels)).toEqual([want])
      expect(fresh.labels).toEqual(expect.arrayContaining([LABELS.optIn, 'bug']))
    })

    it('posts a commentOnce comment once per key', async () => {
      const u = await make()
      const { tracker } = u
      const t = await u.seedTicket([LABELS.optIn])
      await tracker.commentOnce(t, 'gave-up', 'Giving up')
      await tracker.commentOnce(t, 'gave-up', 'Giving up')
      expect(await u.comments(t)).toHaveLength(1)
      await tracker.commentOnce(t, 'other', 'Something else')
      expect(await u.comments(t)).toHaveLength(2)
    })

    it('removes only the named label', async () => {
      const u = await make()
      const { tracker } = u
      const t = await u.seedTicket([LABELS.optIn, LABELS.retry, 'bug'])
      await tracker.removeLabel(t, LABELS.retry)
      expect(t.labels).toEqual([LABELS.optIn, 'bug'])
      expect([...(await tracker.getTicket(t.id)).labels].sort()).toEqual([LABELS.optIn, 'bug'].sort())
    })

    it('lists only open tickets with the opt-in label', async () => {
      const u = await make()
      const { tracker } = u
      const wanted = await u.seedTicket([LABELS.optIn])
      await u.seedTicket([LABELS.optIn], { closed: true })
      await u.seedTicket(['bug'])
      await u.seedTicket(['rumba:other'])
      expect((await tracker.listCandidates()).map((t) => t.id)).toEqual([wanted.id])
    })
  })
}
