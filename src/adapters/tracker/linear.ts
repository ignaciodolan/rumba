import { LinearClient, type Issue } from '@linear/sdk'
import { renderCriteriaComment } from '../../core/criteria.js'
import { stateLabel } from '../../core/labels.js'
import { decodeStateComment, encodeStateComment } from '../../core/stateComment.js'
import type { Criterion, LabelNames, LinkedDocument, StateName, Ticket, TicketState } from '../../core/types.js'
import type { Tracker } from '../../ports/tracker.js'

/** The small part of Linear this adapter needs; the real one wraps @linear/sdk. */
export interface LinearGateway {
  /** The id of the user the API key belongs to. */
  viewerId(): Promise<string>
  /** Open issues, or with `closed` only the closed ones. */
  issues(o: { team: string; project?: string; label: string; closed?: boolean }): Promise<LinearIssue[]>
  /** Takes the issue UUID or its identifier, such as ENG-12. */
  issue(id: string): Promise<LinearIssue>
  /** Every label an issue of the team can carry: team labels and workspace labels. */
  labels(team: string): Promise<{ id: string; name: string }[]>
  /** Creates a team label. */
  createLabel(team: string, name: string): Promise<{ id: string; name: string }>
  /** Adds one label and keeps the issue's other labels. */
  addLabel(issueId: string, labelId: string): Promise<void>
  /** Removes one label and keeps the issue's other labels. */
  removeLabel(issueId: string, labelId: string): Promise<void>
  /** Oldest first. `authorId` is null when no user wrote the comment. */
  comments(issueId: string): Promise<{ id: string; body: string; authorId: string | null }[]>
  createComment(issueId: string, body: string): Promise<void>
  updateComment(commentId: string, body: string): Promise<void>
  documents(issueId: string): Promise<LinkedDocument[]>
}

export interface LinearIssue { id: string; identifier: string; title: string; description: string; url: string; labels: string[]; open: boolean }

type LabelRef = { id: string; name: string }

function toTicket(i: LinearIssue): Ticket {
  return { id: i.identifier, ref: i.identifier, title: i.title, body: i.description, url: i.url, labels: [...i.labels] }
}

function noteLine(key: string): string {
  return `rumba-note: ${key}`
}

function idsNamed(labels: LabelRef[], name: string): string[] {
  return labels.filter((l) => l.name === name).map((l) => l.id)
}

export class LinearTracker implements Tracker {
  private readonly gateway: LinearGateway
  private readonly team: string
  private readonly project: string | undefined
  private readonly labels: LabelNames
  private readonly stateNames: StateName[]
  private self: Promise<string> | undefined
  /** Identifier (ENG-12) to issue UUID; both are stable. */
  private readonly uuids = new Map<string, string>()

  constructor(o: { gateway: LinearGateway; team: string; project?: string; labels: LabelNames; stateNames: StateName[] }) {
    this.gateway = o.gateway
    this.team = o.team
    this.project = o.project
    this.labels = o.labels
    this.stateNames = o.stateNames
  }

  async ensureLabels(): Promise<void> {
    const existing = await this.gateway.labels(this.team)
    const wanted = [this.labels.optIn, ...this.stateNames.map((s) => stateLabel(this.labels, s)), this.labels.approved, this.labels.retry]
    for (const name of wanted) if (idsNamed(existing, name).length === 0) await this.createLabel(name)
  }

  async listCandidates(opts: { closedIn?: StateName[] } = {}): Promise<Ticket[]> {
    const where = { team: this.team, ...(this.project === undefined ? {} : { project: this.project }), label: this.labels.optIn }
    const tickets = (await this.gateway.issues(where)).filter((i) => i.open && i.labels.includes(this.labels.optIn))
    const closedLabels = new Set((opts.closedIn ?? []).map((s) => stateLabel(this.labels, s)))
    if (closedLabels.size > 0) {
      const closed = await this.gateway.issues({ ...where, closed: true })
      tickets.push(...closed.filter((i) => !i.open && i.labels.includes(this.labels.optIn) && i.labels.some((l) => closedLabels.has(l))))
    }
    const seen = new Set<string>()
    return tickets.filter((i) => !seen.has(i.identifier) && seen.add(i.identifier)).map((i) => this.remember(i))
  }

  async getTicket(id: string): Promise<Ticket> {
    return this.remember(await this.gateway.issue(id))
  }

  async readState(t: Ticket): Promise<TicketState | null> {
    return (await this.findState(t))?.state ?? null
  }

  async writeState(t: Ticket, s: TicketState): Promise<void> {
    const body = encodeStateComment(s)
    const found = await this.findState(t)
    if (found) await this.gateway.updateComment(found.commentId, body)
    else await this.comment(t, body)

    // Single add and remove calls on labels read just now, so a label a person adds
    // meanwhile is kept. The new label goes on first, so the ticket always carries one.
    const uuid = await this.uuidOf(t)
    const want = stateLabel(this.labels, s.state)
    const others = new Set(this.stateNames.map((n) => stateLabel(this.labels, n)).filter((l) => l !== want))
    const known = await this.gateway.labels(this.team)
    const current = (await this.gateway.issue(uuid)).labels
    if (!current.includes(want)) {
      const ids = idsNamed(known, want)
      await this.gateway.addLabel(uuid, ids[0] ?? (await this.createLabel(want)))
    }
    for (const label of current) {
      if (!others.has(label)) continue
      for (const id of idsNamed(known, label)) await this.gateway.removeLabel(uuid, id)
    }
    t.labels = [...t.labels.filter((l) => !others.has(l) && l !== want), want]
  }

  async postCriteria(t: Ticket, c: Criterion[]): Promise<void> {
    await this.comment(t, renderCriteriaComment(c, this.labels))
  }

  async readLinkedDocuments(t: Ticket): Promise<LinkedDocument[]> {
    return this.gateway.documents(await this.uuidOf(t))
  }

  async removeLabel(t: Ticket, label: string): Promise<void> {
    const uuid = await this.uuidOf(t)
    if ((await this.gateway.issue(uuid)).labels.includes(label)) {
      for (const id of idsNamed(await this.gateway.labels(this.team), label)) await this.gateway.removeLabel(uuid, id)
    }
    t.labels = t.labels.filter((l) => l !== label)
  }

  async comment(t: Ticket, body: string): Promise<void> {
    await this.gateway.createComment(await this.uuidOf(t), body)
  }

  async commentOnce(t: Ticket, key: string, body: string): Promise<void> {
    const line = noteLine(key)
    const comments = await this.trustedComments(t)
    if (comments.some((c) => c.body.split(/\r?\n/).some((l) => l.trim() === line))) return
    await this.comment(t, `${body}\n\n${line}`)
  }

  private remember(i: LinearIssue): Ticket {
    this.uuids.set(i.identifier, i.id)
    return toTicket(i)
  }

  private async uuidOf(t: Ticket): Promise<string> {
    const known = this.uuids.get(t.id)
    if (known !== undefined) return known
    const issue = await this.gateway.issue(t.id)
    this.uuids.set(t.id, issue.id)
    return issue.id
  }

  /** Creates a team label; one that someone else created meanwhile counts as success. */
  private async createLabel(name: string): Promise<string> {
    try {
      return (await this.gateway.createLabel(this.team, name)).id
    } catch (e) {
      const id = idsNamed(await this.gateway.labels(this.team), name)[0]
      if (id === undefined) throw e
      return id
    }
  }

  /**
   * Comments are untrusted: anyone who can comment could forge a state comment or a note.
   * Only comments by the user the API key belongs to are read.
   */
  private async trustedComments(t: Ticket): Promise<{ id: string; body: string }[]> {
    const all = await this.gateway.comments(await this.uuidOf(t))
    const self = await this.ownId()
    return all.filter((c) => c.authorId === self)
  }

  /** Fails closed when the lookup fails. Only a successful lookup is kept. */
  private ownId(): Promise<string> {
    if (this.self) return this.self
    const lookup = this.gateway.viewerId()
    this.self = lookup
    lookup.catch(() => {
      if (this.self === lookup) this.self = undefined
    })
    return lookup
  }

  /** The last trusted comment that holds a valid state. */
  private async findState(t: Ticket): Promise<{ commentId: string; state: TicketState } | null> {
    const comments = await this.trustedComments(t)
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!
      const state = decodeStateComment(c.body)
      if (state) return { commentId: c.id, state }
    }
    return null
  }
}

/** Workflow state types of a finished issue. The SDK lists "duplicate" as a type of its own. */
const CLOSED_STATE_TYPES = ['completed', 'canceled', 'duplicate']
const PAGE_SIZE = 100

interface Page<T> { nodes: T[]; pageInfo: { hasNextPage: boolean }; fetchNext(): Promise<Page<T>> }

/** Every node of an SDK connection; fetchNext appends the next page to `nodes`. */
async function allNodes<T>(first: Page<T>): Promise<T[]> {
  let page = first
  while (page.pageInfo.hasNextPage) page = await page.fetchNext()
  return page.nodes
}

/** Thin wrapper over @linear/sdk. Not run in tests: checked by the type checker only. */
export class SdkLinearGateway implements LinearGateway {
  private readonly client: LinearClient
  private readonly teamIds = new Map<string, string>()

  constructor(apiKey: string) {
    this.client = new LinearClient({ apiKey })
  }

  async viewerId(): Promise<string> {
    return (await this.client.viewer).id
  }

  async issues(o: { team: string; project?: string; label: string; closed?: boolean }): Promise<LinearIssue[]> {
    const issues = await allNodes(await this.client.issues({
      first: PAGE_SIZE,
      filter: {
        team: { key: { eq: o.team } },
        labels: { some: { name: { eq: o.label } } },
        state: { type: o.closed ? { in: CLOSED_STATE_TYPES } : { nin: CLOSED_STATE_TYPES } },
        ...(o.project === undefined ? {} : { project: { name: { eq: o.project } } }),
      },
    }))
    return Promise.all(issues.map((i) => this.toIssue(i)))
  }

  async issue(id: string): Promise<LinearIssue> {
    return this.toIssue(await this.client.issue(id))
  }

  async labels(team: string): Promise<{ id: string; name: string }[]> {
    const labels = await allNodes(await this.client.issueLabels({
      first: PAGE_SIZE,
      filter: { or: [{ team: { key: { eq: team } } }, { team: { null: true } }] },
    }))
    // A group label cannot be put on an issue.
    return labels.filter((l) => !l.isGroup).map((l) => ({ id: l.id, name: l.name }))
  }

  async createLabel(team: string, name: string): Promise<{ id: string; name: string }> {
    const payload = await this.client.createIssueLabel({ name, teamId: await this.teamId(team) })
    const id = payload.issueLabelId
    if (!payload.success || id === undefined) throw new Error(`Linear did not create the label ${name}`)
    return { id, name }
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    await this.client.issueAddLabel(issueId, labelId)
  }

  async removeLabel(issueId: string, labelId: string): Promise<void> {
    await this.client.issueRemoveLabel(issueId, labelId)
  }

  async comments(issueId: string): Promise<{ id: string; body: string; authorId: string | null }[]> {
    const issue = await this.client.issue(issueId)
    const comments = await allNodes(await issue.comments({ first: PAGE_SIZE }))
    return comments
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((c) => ({ id: c.id, body: c.body, authorId: c.userId ?? null }))
  }

  async createComment(issueId: string, body: string): Promise<void> {
    await this.client.createComment({ issueId, body })
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    await this.client.updateComment(commentId, { body })
  }

  /** The Linear documents that belong to the issue (Issue.documents). */
  async documents(issueId: string): Promise<LinkedDocument[]> {
    const issue = await this.client.issue(issueId)
    const docs = await allNodes(await issue.documents({ first: PAGE_SIZE }))
    return docs.map((d) => ({ title: d.title, body: d.content ?? '' }))
  }

  private async teamId(key: string): Promise<string> {
    const known = this.teamIds.get(key)
    if (known !== undefined) return known
    const [team] = (await this.client.teams({ filter: { key: { eq: key } } })).nodes
    if (!team) throw new Error(`No Linear team with key ${key}`)
    this.teamIds.set(key, team.id)
    return team.id
  }

  private async toIssue(i: Issue): Promise<LinearIssue> {
    const [labels, state] = await Promise.all([allNodes(await i.labels({ first: PAGE_SIZE })), i.state])
    return {
      id: i.id,
      identifier: i.identifier,
      title: i.title,
      description: i.description ?? '',
      url: i.url,
      labels: labels.map((l) => l.name),
      open: state !== undefined && !CLOSED_STATE_TYPES.includes(state.type),
    }
  }
}
