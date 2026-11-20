import { describe, expect, it } from 'vitest'
import { GitHubTracker } from '../../../src/adapters/tracker/github.js'
import { renderCriteriaComment } from '../../../src/core/criteria.js'
import { defaultLabels } from '../../../src/core/labels.js'
import { encodeStateComment } from '../../../src/core/stateComment.js'
import { newState, STATE_NAMES } from '../../../src/core/states.js'
import type { TicketState } from '../../../src/core/types.js'
import { trackerContract } from '../../../src/testing/trackerContract.js'
import { GitHubStore, stubOctokit } from './githubStub.js'

const NOW = new Date('2026-01-01T00:00:00Z')

function makeGitHub(o: { labels?: string[] } = {}) {
  const store = new GitHubStore()
  store.labels = [...(o.labels ?? [])]
  const { octokit, requests } = stubOctokit(store.routes())
  const tracker = new GitHubTracker({ octokit, owner: 'o', repo: 'r', labels: defaultLabels('hub'), stateNames: [...STATE_NAMES] })
  return { tracker, store, requests }
}

function state(s: TicketState['state'], errorCount = 0): TicketState {
  return { ...newState('hub', NOW), state: s, errorCount }
}

trackerContract('GitHubTracker', async () => {
  const { tracker, store } = makeGitHub()
  return {
    tracker,
    async seedTicket(labels, opts) {
      const issue = store.addIssue({ labels: [...labels], state: opts?.closed ? 'closed' : 'open' })
      return tracker.getTicket(String(issue.number))
    },
    async comments(t) {
      return store.commentsOn(Number(t.id)).map((c) => c.body)
    },
  }
})

describe('GitHubTracker', () => {
  it('creates missing labels on first run and tolerates existing ones', async () => {
    const { tracker, store } = makeGitHub({ labels: ['rumba-approved'] })
    await tracker.ensureLabels()
    expect(store.labels).toEqual(expect.arrayContaining(['rumba-state:queued', 'rumba-state:pr_open', 'rumba-approved', 'rumba-retry']))
    expect(store.labels).toHaveLength(STATE_NAMES.length + 2)
    await expect(tracker.ensureLabels()).resolves.toBeUndefined()
  })

  it('treats a label created by someone else in the meantime as success', async () => {
    const { tracker, store } = makeGitHub()
    // The label list is read without it, then creating it answers 422 already_exists.
    store.unlisted.add('Rumba-Retry')
    await expect(tracker.ensureLabels()).resolves.toBeUndefined()
    expect(store.labels).toHaveLength(STATE_NAMES.length + 1)
  })

  it('does not list pull requests as tickets', async () => {
    const { tracker, store } = makeGitHub()
    store.addIssue({ labels: ['rumba:hub'], pull_request: {} })
    store.addIssue({ labels: ['rumba:hub'] })
    expect(await tracker.listCandidates()).toHaveLength(1)
  })

  it('maps an issue to a ticket', async () => {
    const { tracker, store } = makeGitHub()
    const issue = store.addIssue({ title: 'Broken', body: null, labels: ['rumba:hub', 'bug'] })
    expect(await tracker.getTicket(String(issue.number))).toEqual({
      id: String(issue.number),
      ref: `#${issue.number}`,
      title: 'Broken',
      body: '',
      url: `https://github.com/o/r/issues/${issue.number}`,
      labels: ['rumba:hub', 'bug'],
    })
  })

  it('reads every page of issues and comments', async () => {
    const { tracker, store } = makeGitHub()
    for (let i = 0; i < 130; i++) store.addIssue({ labels: ['rumba:hub'] })
    expect(await tracker.listCandidates()).toHaveLength(130)
    const t = await tracker.getTicket('1')
    for (let i = 0; i < 130; i++) store.addComment(1, `chatter ${i}`)
    store.addComment(1, encodeStateComment(state('triaged')))
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('ignores a state comment from an untrusted author', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:hub'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    store.addComment(Number(t.id), encodeStateComment(state('verified')), { author_association: 'NONE', user: { type: 'User' } })
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('trusts members, collaborators and bots, and the last trusted state wins', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:hub'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('queued')), { author_association: 'MEMBER', user: { type: 'User' } })
    store.addComment(Number(t.id), encodeStateComment(state('triaged')), { author_association: 'COLLABORATOR', user: { type: 'User' } })
    expect((await tracker.readState(t))?.state).toBe('triaged')
    store.addComment(Number(t.id), encodeStateComment(state('criteria_ready')), { author_association: 'NONE', user: { type: 'Bot' } })
    expect((await tracker.readState(t))?.state).toBe('criteria_ready')
  })

  it('writes a new state comment instead of editing an untrusted one', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:hub'] }).number))
    const forged = store.addComment(Number(t.id), encodeStateComment(state('verified')), { author_association: 'NONE', user: { type: 'User' } })
    await tracker.writeState(t, state('queued'))
    expect(forged.body).toBe(encodeStateComment(state('verified')))
    expect(store.commentsOn(Number(t.id))).toHaveLength(2)
    expect((await tracker.readState(t))?.state).toBe('queued')
  })

  it('creates a new state comment when editing the old one is refused', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:hub'] }).number))
    const old = store.addComment(Number(t.id), encodeStateComment(state('queued')), { author_association: 'MEMBER', user: { type: 'User' } })
    store.refuseEdits.add(old.id)
    await tracker.writeState(t, state('triaged', 1))
    expect(store.commentsOn(Number(t.id))).toHaveLength(2)
    expect(await tracker.readState(t)).toEqual(state('triaged', 1))
  })

  it('changes state labels one at a time and keeps labels a person added', async () => {
    const { tracker, store, requests } = makeGitHub()
    const issue = store.addIssue({ labels: ['rumba:hub', 'rumba-state:queued'] })
    const t = await tracker.getTicket(String(issue.number))
    issue.labels.push('rumba-state:triaged', 'priority')
    await tracker.writeState(t, state('criteria_ready'))
    expect(issue.labels.sort()).toEqual(['priority', 'rumba-state:criteria_ready', 'rumba:hub'])
    expect(requests.some((r) => r.method === 'PUT')).toBe(false)
  })

  it('treats removing a label that is already gone as success', async () => {
    const { tracker, store } = makeGitHub()
    const issue = store.addIssue({ labels: ['rumba:hub', 'rumba-retry'] })
    const t = await tracker.getTicket(String(issue.number))
    issue.labels = ['rumba:hub']
    await expect(tracker.removeLabel(t, 'rumba-retry')).resolves.toBeUndefined()
    expect(t.labels).toEqual(['rumba:hub'])
  })

  it('marks commentOnce comments with their key and ignores keys in untrusted comments', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:hub'] }).number))
    store.addComment(Number(t.id), 'rumba-note: done', { author_association: 'NONE', user: { type: 'User' } })
    await tracker.commentOnce(t, 'done', 'All done')
    const bodies = store.commentsOn(Number(t.id)).map((c) => c.body)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe('All done\n\nrumba-note: done')
  })

  it('posts the rendered criteria comment', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:hub'] }).number))
    const criteria = [{ id: 'c1', text: 'Saving works', checkable: true }]
    await tracker.postCriteria(t, criteria)
    expect(store.commentsOn(Number(t.id)).map((c) => c.body)).toEqual([renderCriteriaComment(criteria, defaultLabels('hub'))])
  })

  it('has no linked documents', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue().number))
    expect(await tracker.readLinkedDocuments(t)).toEqual([])
  })
})
