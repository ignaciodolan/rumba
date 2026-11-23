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
const UNKNOWN_LOGIN = 'Could not determine which GitHub account Rumba runs as. Set RUMBA_GITHUB_LOGIN to its login (for the GitHub Actions token: github-actions[bot]).'
const OWNER = { author_association: 'OWNER', user: { login: 'someone', type: 'User' } }
const OTHER_BOT = { author_association: 'NONE', user: { login: 'other[bot]', type: 'Bot' } }
/** The first line of every body Rumba writes on GitHub. */
const OWN = '<!-- rumba:own -->\n'

function makeGitHub(o: { labels?: string[]; login?: string } = {}) {
  const store = new GitHubStore()
  store.labels = [...(o.labels ?? [])]
  const { octokit, requests } = stubOctokit(store.routes())
  const tracker = new GitHubTracker({ octokit, owner: 'o', repo: 'r', labels: defaultLabels('shop'), stateNames: [...STATE_NAMES], login: o.login })
  return { tracker, store, requests }
}

function state(s: TicketState['state'], errorCount = 0): TicketState {
  return { ...newState('shop', NOW), state: s, errorCount }
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
    expect(store.labels).toEqual(expect.arrayContaining(['rumba:shop', 'rumba-state:queued', 'rumba-state:pr_open', 'rumba-approved', 'rumba-retry', 'rumba-revise']))
    expect(store.labels).toHaveLength(STATE_NAMES.length + 4)
    await expect(tracker.ensureLabels()).resolves.toBeUndefined()
  })

  it('treats a label created by someone else in the meantime as success', async () => {
    const { tracker, store } = makeGitHub()
    // The label list is read without it, then creating it answers 422 already_exists.
    store.unlisted.add('Rumba-Retry')
    await expect(tracker.ensureLabels()).resolves.toBeUndefined()
    expect(store.labels).toHaveLength(STATE_NAMES.length + 3)
  })

  it('does not list pull requests as tickets', async () => {
    const { tracker, store } = makeGitHub()
    store.addIssue({ labels: ['rumba:shop'], pull_request: {} })
    store.addIssue({ labels: ['rumba:shop'] })
    expect(await tracker.listCandidates()).toHaveLength(1)
  })

  it('maps an issue to a ticket', async () => {
    const { tracker, store } = makeGitHub()
    const issue = store.addIssue({ title: 'Broken', body: null, labels: ['rumba:shop', 'bug'] })
    expect(await tracker.getTicket(String(issue.number))).toEqual({
      id: String(issue.number),
      ref: `#${issue.number}`,
      title: 'Broken',
      body: '',
      url: `https://github.com/o/r/issues/${issue.number}`,
      labels: ['rumba:shop', 'bug'],
    })
  })

  it('reads every page of issues and comments', async () => {
    const { tracker, store } = makeGitHub()
    for (let i = 0; i < 130; i++) store.addIssue({ labels: ['rumba:shop'] })
    expect(await tracker.listCandidates()).toHaveLength(130)
    const t = await tracker.getTicket('1')
    for (let i = 0; i < 130; i++) store.addComment(1, `chatter ${i}`)
    store.addComment(1, encodeStateComment(state('triaged')))
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('reads a state comment by its own login and ignores an owner or another bot', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    store.addComment(Number(t.id), encodeStateComment(state('verified')), OWNER)
    store.addComment(Number(t.id), encodeStateComment(state('pr_open')), OTHER_BOT)
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('takes the last of its own state comments', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('queued')))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('uses the REST login when the GraphQL viewer lookup fails', async () => {
    const { tracker, store } = makeGitHub()
    store.viewerLogin = null
    store.userLogin = 'rest-bot'
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')), { author_association: 'NONE', user: { login: 'rest-bot', type: 'User' } })
    store.addComment(Number(t.id), encodeStateComment(state('verified')))
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('fails closed when neither login lookup answers, and reads no bot comment', async () => {
    const { tracker, store } = makeGitHub()
    store.viewerLogin = null
    store.userLogin = null
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')), OTHER_BOT)
    await expect(tracker.readState(t)).rejects.toThrow(UNKNOWN_LOGIN)
  })

  it('looks the login up again after a failed lookup', async () => {
    const { tracker, store } = makeGitHub()
    store.viewerLogin = null
    store.userLogin = null
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    await expect(tracker.readState(t)).rejects.toThrow(UNKNOWN_LOGIN)
    store.viewerLogin = 'rumba-bot'
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('uses a given login without looking it up', async () => {
    const { tracker, store, requests } = makeGitHub({ login: 'rumba-bot' })
    store.viewerLogin = 'someone'
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    store.addComment(Number(t.id), encodeStateComment(state('verified')), OWNER)
    store.addComment(Number(t.id), encodeStateComment(state('pr_open')), OTHER_BOT)
    expect((await tracker.readState(t))?.state).toBe('triaged')
    await tracker.commentOnce(t, 'k', 'Body')
    expect(store.loginLookups).toBe(0)
    expect(requests.some((r) => r.path === '/graphql' || r.path === '/user')).toBe(false)
  })

  it('looks its login up once across calls', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    await Promise.all([tracker.readState(t), tracker.readState(t)])
    await tracker.writeState(t, state('queued'))
    await tracker.commentOnce(t, 'k', 'Body')
    expect(store.loginLookups).toBe(1)
  })

  it('writes a new state comment instead of editing an untrusted one', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    const forged = store.addComment(Number(t.id), encodeStateComment(state('verified')), OWNER)
    await tracker.writeState(t, state('queued'))
    expect(forged.body).toBe(encodeStateComment(state('verified')))
    expect(store.commentsOn(Number(t.id))).toHaveLength(2)
    expect((await tracker.readState(t))?.state).toBe('queued')
  })

  it('creates a new state comment when editing the old one is refused', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    const old = store.addComment(Number(t.id), encodeStateComment(state('queued')))
    store.refuseEdits.add(old.id)
    await tracker.writeState(t, state('triaged', 1))
    expect(store.commentsOn(Number(t.id))).toHaveLength(2)
    expect(await tracker.readState(t)).toEqual(state('triaged', 1))
  })

  it('changes state labels one at a time and keeps labels a person added', async () => {
    const { tracker, store, requests } = makeGitHub()
    const issue = store.addIssue({ labels: ['rumba:shop', 'rumba-state:queued'] })
    const t = await tracker.getTicket(String(issue.number))
    issue.labels.push('rumba-state:triaged', 'priority')
    await tracker.writeState(t, state('criteria_ready'))
    expect(issue.labels.sort()).toEqual(['priority', 'rumba-state:criteria_ready', 'rumba:shop'])
    expect(requests.some((r) => r.method === 'PUT')).toBe(false)
  })

  it('treats removing a label that is already gone as success', async () => {
    const { tracker, store } = makeGitHub()
    const issue = store.addIssue({ labels: ['rumba:shop', 'rumba-retry'] })
    const t = await tracker.getTicket(String(issue.number))
    issue.labels = ['rumba:shop']
    await expect(tracker.removeLabel(t, 'rumba-retry')).resolves.toBeUndefined()
    expect(t.labels).toEqual(['rumba:shop'])
  })

  it('marks commentOnce comments with their key and ignores keys in untrusted comments', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), 'rumba-note: done', OWNER)
    await tracker.commentOnce(t, 'done', 'All done')
    const bodies = store.commentsOn(Number(t.id)).map((c) => c.body)
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(`${OWN}All done\n\nrumba-note: done`)
  })

  it('posts the rendered criteria comment', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    const criteria = [{ id: 'c1', text: 'Saving works', checkable: true }]
    await tracker.postCriteria(t, criteria)
    expect(store.commentsOn(Number(t.id)).map((c) => c.body)).toEqual([`${OWN}${renderCriteriaComment(criteria, defaultLabels('shop'))}`])
  })

  it('starts a plain comment with the marker line', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    await tracker.comment(t, 'The pull request was merged.')
    expect(store.commentsOn(Number(t.id)).map((c) => c.body)).toEqual([`${OWN}The pull request was merged.`])
  })

  it('starts a new state comment and an edited one with the marker line, and reads both back', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    await tracker.writeState(t, state('queued'))
    expect(store.commentsOn(Number(t.id)).map((c) => c.body)).toEqual([`${OWN}${encodeStateComment(state('queued'))}`])
    expect(await tracker.readState(t)).toEqual(state('queued'))
    await tracker.writeState(t, state('triaged', 1))
    expect(store.commentsOn(Number(t.id)).map((c) => c.body)).toEqual([`${OWN}${encodeStateComment(state('triaged', 1))}`])
    expect(await tracker.readState(t)).toEqual(state('triaged', 1))
  })

  it('still reads a state comment written before the marker line', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('ignores a state comment with the marker line written by another account', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), encodeStateComment(state('triaged')))
    store.addComment(Number(t.id), `${OWN}${encodeStateComment(state('verified'))}`, OWNER)
    store.addComment(Number(t.id), `${OWN}${encodeStateComment(state('pr_open'))}`, OTHER_BOT)
    expect((await tracker.readState(t))?.state).toBe('triaged')
  })

  it('ignores a commentOnce key with the marker line written by another account', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue({ labels: ['rumba:shop'] }).number))
    store.addComment(Number(t.id), `${OWN}Done\n\nrumba-note: done`, OWNER)
    await tracker.commentOnce(t, 'done', 'All done')
    expect(store.commentsOn(Number(t.id))).toHaveLength(2)
  })

  it('has no linked documents', async () => {
    const { tracker, store } = makeGitHub()
    const t = await tracker.getTicket(String(store.addIssue().number))
    expect(await tracker.readLinkedDocuments(t)).toEqual([])
  })
})
