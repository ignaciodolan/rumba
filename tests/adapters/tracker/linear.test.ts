import { describe, expect, it } from 'vitest'
import { LinearTracker } from '../../../src/adapters/tracker/linear.js'
import { defaultLabels } from '../../../src/core/labels.js'
import { encodeStateComment } from '../../../src/core/stateComment.js'
import { newState, STATE_NAMES } from '../../../src/core/states.js'
import type { TicketState } from '../../../src/core/types.js'
import { trackerContract } from '../../../src/testing/trackerContract.js'
import { memoryGateway, RUMBA_USER } from './linearMemory.js'

const NOW = new Date('2026-01-01T00:00:00Z')
const stateNames = [...STATE_NAMES]
const SOMEONE = 'user-someone'

function state(s: TicketState['state']): TicketState {
  return { ...newState('hub', NOW), state: s }
}

function makeLinear(o: { project?: string } = {}) {
  const g = memoryGateway()
  const tracker = new LinearTracker({ gateway: g, team: 'ENG', ...o, labels: defaultLabels('hub'), stateNames })
  return { g, tracker }
}

trackerContract('linear', async () => {
  const { g, tracker } = makeLinear()
  return {
    tracker,
    async seedTicket(labels, opts) {
      return tracker.getTicket(g.add({ team: 'ENG', labels: [...labels], closed: opts?.closed ?? false }).identifier)
    },
    async comments(t) {
      return g.commentsOn(t.id).map((c) => c.body)
    },
  }
})

describe('LinearTracker', () => {
  it('lists only tickets of its team and project', async () => {
    const g = memoryGateway(); g.add({ team: 'ENG', project: 'Checkout', labels: ['rumba:hub'] }); g.add({ team: 'OPS', labels: ['rumba:hub'] })
    const t = new LinearTracker({ gateway: g, team: 'ENG', project: 'Checkout', labels: defaultLabels('hub'), stateNames })
    expect(await t.listCandidates()).toHaveLength(1)
  })

  it('uses the identifier as id and ref', async () => {
    const g = memoryGateway(); g.add({ team: 'ENG', identifier: 'ENG-12', labels: ['rumba:hub'] })
    const [ticket] = await new LinearTracker({ gateway: g, team: 'ENG', labels: defaultLabels('hub'), stateNames }).listCandidates()
    expect(ticket).toMatchObject({ id: 'ENG-12', ref: 'ENG-12' })
  })

  it('returns linked documents', async () => {
    const g = memoryGateway(); g.add({ team: 'ENG', labels: ['rumba:hub'], documents: [{ title: 'Spec', body: 'x' }] })
    const t = new LinearTracker({ gateway: g, team: 'ENG', labels: defaultLabels('hub'), stateNames })
    expect(await t.readLinkedDocuments((await t.listCandidates())[0]!)).toEqual([{ title: 'Spec', body: 'x' }])
  })

  it('maps an issue to a ticket', async () => {
    const { g, tracker } = makeLinear()
    g.add({ team: 'ENG', identifier: 'ENG-7', title: 'Broken', labels: ['rumba:hub', 'bug'] })
    expect(await tracker.getTicket('ENG-7')).toEqual({
      id: 'ENG-7', ref: 'ENG-7', title: 'Broken', body: '', url: 'https://linear.app/acme/issue/ENG-7', labels: ['rumba:hub', 'bug'],
    })
  })

  it('lists tickets of the team in any project when no project is set', async () => {
    const { g, tracker } = makeLinear()
    g.add({ team: 'ENG', project: 'Checkout', labels: ['rumba:hub'] })
    g.add({ team: 'ENG', labels: ['rumba:hub'] })
    expect(await tracker.listCandidates()).toHaveLength(2)
  })

  it('creates missing labels as team labels and tolerates existing ones', async () => {
    const { g, tracker } = makeLinear()
    g.defineLabel('rumba-approved', null)
    await tracker.ensureLabels()
    const names = g.labelList.map((l) => l.name)
    expect(names).toEqual(expect.arrayContaining(['rumba-state:queued', 'rumba-state:pr_open', 'rumba-approved', 'rumba-retry']))
    expect(names).toHaveLength(STATE_NAMES.length + 2)
    expect(g.labelList.filter((l) => l.name !== 'rumba-approved').every((l) => l.team === 'ENG')).toBe(true)
    await expect(tracker.ensureLabels()).resolves.toBeUndefined()
    expect(g.labelList).toHaveLength(STATE_NAMES.length + 2)
  })

  it('treats a label created by someone else in the meantime as success', async () => {
    const { g, tracker } = makeLinear()
    g.defineLabel('rumba-retry', 'ENG')
    g.unlisted.add('rumba-retry')
    await expect(tracker.ensureLabels()).resolves.toBeUndefined()
    expect(g.labelList).toHaveLength(STATE_NAMES.length + 2)
  })

  it('keeps a label a person added during the run when writing state', async () => {
    const { g, tracker } = makeLinear()
    const urgent = g.defineLabel('urgent', 'ENG')
    const issue = g.add({ team: 'ENG', labels: ['rumba:hub'] })
    const t = await tracker.getTicket(issue.identifier)
    await tracker.writeState(t, state('queued'))
    g.personAddsLabel(issue.id, urgent)
    await tracker.writeState(t, state('triaged'))
    expect(g.labelNamesOf(issue.id).sort()).toEqual(['rumba-state:triaged', 'rumba:hub', 'urgent'].sort())
  })

  it('keeps a label it cannot resolve to an id', async () => {
    const { g, tracker } = makeLinear()
    const foreign = g.defineLabel('ops-only', 'OPS')
    const issue = g.add({ team: 'ENG', labels: ['rumba:hub'] })
    g.personAddsLabel(issue.id, foreign)
    const t = await tracker.getTicket(issue.identifier)
    await tracker.writeState(t, state('queued'))
    await tracker.removeLabel(t, 'rumba:hub')
    expect(g.labelNamesOf(issue.id).sort()).toEqual(['ops-only', 'rumba-state:queued'])
  })

  it('reads a state comment by its own user and ignores another user', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    g.addComment(t.id, encodeStateComment(state('triaged')), RUMBA_USER)
    g.addComment(t.id, encodeStateComment(state('verified')), SOMEONE)
    g.addComment(t.id, encodeStateComment(state('pr_open')), null)
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('writes a new state comment instead of editing one by another user', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    g.addComment(t.id, encodeStateComment(state('verified')), SOMEONE)
    await tracker.writeState(t, state('queued'))
    expect(g.commentsOn(t.id).map((c) => c.authorId)).toEqual([SOMEONE, RUMBA_USER])
    expect(g.commentsOn(t.id)[0]!.body).toBe(encodeStateComment(state('verified')))
  })

  it('takes the last of its own state comments', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    g.addComment(t.id, encodeStateComment(state('queued')), RUMBA_USER)
    g.addComment(t.id, encodeStateComment(state('triaged')), RUMBA_USER)
    g.addComment(t.id, 'just chatting', RUMBA_USER)
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('is not silenced by a forged note line from another user', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    g.addComment(t.id, 'nothing to see\n\nrumba-note: gave-up', SOMEONE)
    await tracker.commentOnce(t, 'gave-up', 'Giving up')
    expect(g.commentsOn(t.id).map((c) => c.body)).toEqual(['nothing to see\n\nrumba-note: gave-up', 'Giving up\n\nrumba-note: gave-up'])
  })

  it('fails closed when the viewer lookup fails, and looks it up again next time', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    g.addComment(t.id, encodeStateComment(state('triaged')), RUMBA_USER)
    g.viewer = null
    await expect(tracker.readState(t)).rejects.toThrow('viewer lookup failed')
    g.viewer = RUMBA_USER
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('looks the viewer up once across calls', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    await tracker.readState(t)
    await tracker.writeState(t, state('queued'))
    await tracker.commentOnce(t, 'k', 'Body')
    expect(g.viewerLookups).toBe(1)
  })

  it('posts criteria as a comment', async () => {
    const { g, tracker } = makeLinear()
    const t = await tracker.getTicket(g.add({ team: 'ENG', labels: ['rumba:hub'] }).identifier)
    await tracker.postCriteria(t, [{ id: 'c1', text: 'Saving works', checkable: true }])
    expect(g.commentsOn(t.id)[0]!.body).toContain('- [ ] Saving works')
  })
})
