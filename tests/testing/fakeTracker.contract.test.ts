import { newState } from '../../src/core/states.js'
import type { StateName } from '../../src/core/types.js'
import { FakeTracker, makeTicket } from '../../src/testing/fakes.js'
import { trackerContract } from '../../src/testing/trackerContract.js'

trackerContract('FakeTracker', async () => {
  const tracker = new FakeTracker()
  let n = 0
  return {
    tracker,
    async seedTicket(labels, opts) {
      n += 1
      const t = makeTicket({ id: String(n), ref: `#${n}`, labels: [...labels] })
      tracker.tickets.push(t)
      if (opts?.closed) tracker.closed.add(t.id)
      // The fake reads state from `states`; seed it from the state label the contract gives.
      const label = labels.find((l) => l.startsWith('rumba-state:'))
      if (label) tracker.states.set(t.id, { ...newState('shop', new Date('2026-01-01T00:00:00Z')), state: label.slice('rumba-state:'.length) as StateName })
      return structuredClone(t)
    },
    async comments(t) {
      return tracker.comments.filter((c) => c.ticketId === t.id).map((c) => c.body)
    },
  }
})
