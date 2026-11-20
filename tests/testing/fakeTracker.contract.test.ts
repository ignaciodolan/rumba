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
      return structuredClone(t)
    },
    async comments(t) {
      return tracker.comments.filter((c) => c.ticketId === t.id).map((c) => c.body)
    },
  }
})
