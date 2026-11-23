import type { LinearGateway, LinearIssue } from '../../../src/adapters/tracker/linear.js'
import type { LinkedDocument } from '../../../src/core/types.js'

export const RUMBA_USER = 'user-rumba'

interface StoredLabel { id: string; name: string; team: string | null }
interface StoredComment { id: string; issueId: string; body: string; authorId: string | null }
export interface StoredIssue {
  id: string
  identifier: string
  team: string
  project?: string
  title: string
  description: string
  labelIds: string[]
  closed: boolean
  documents: LinkedDocument[]
}

/** An in-memory Linear workspace. Labels are team or workspace labels, referenced by id. */
export class MemoryLinearGateway implements LinearGateway {
  readonly issuesById = new Map<string, StoredIssue>()
  readonly labelList: StoredLabel[] = []
  readonly commentList: StoredComment[] = []
  /** The user the API key belongs to; null makes viewerId fail. */
  viewer: string | null = RUMBA_USER
  viewerLookups = 0
  /** Label names that already exist but are left out of the next labels() answer only. */
  readonly unlisted = new Set<string>()
  private next = 1
  private readonly numbers = new Map<string, number>()

  add(o: {
    team: string; project?: string; identifier?: string; title?: string; description?: string
    labels?: string[]; closed?: boolean; documents?: LinkedDocument[]
  }): StoredIssue {
    const n = (this.numbers.get(o.team) ?? 0) + 1
    this.numbers.set(o.team, n)
    const issue: StoredIssue = {
      id: this.newId('issue'),
      identifier: o.identifier ?? `${o.team}-${n}`,
      team: o.team,
      ...(o.project === undefined ? {} : { project: o.project }),
      title: o.title ?? 'A ticket',
      description: o.description ?? '',
      labelIds: (o.labels ?? []).map((name) => this.labelNamed(name, o.team).id),
      closed: o.closed ?? false,
      documents: o.documents ?? [],
    }
    this.issuesById.set(issue.id, issue)
    return issue
  }

  /** Adds a label to the workspace (team null) or to one team. */
  defineLabel(name: string, team: string | null): StoredLabel {
    const label = { id: this.newId('label'), name, team }
    this.labelList.push(label)
    return label
  }

  addComment(issueId: string, body: string, authorId: string | null): void {
    this.commentList.push({ id: this.newId('comment'), issueId: this.find(issueId).id, body, authorId })
  }

  commentsOn(issueId: string): StoredComment[] {
    const id = this.find(issueId).id
    return this.commentList.filter((c) => c.issueId === id)
  }

  labelNamesOf(issueId: string): string[] {
    return this.find(issueId).labelIds.map((id) => this.labelList.find((l) => l.id === id)!.name)
  }

  /** Puts a label on an issue directly, as a person would. */
  personAddsLabel(issueId: string, label: StoredLabel): void {
    this.find(issueId).labelIds.push(label.id)
  }

  async viewerId(): Promise<string> {
    this.viewerLookups++
    if (this.viewer === null) throw new Error('viewer lookup failed')
    return this.viewer
  }

  async issues(o: { team: string; project?: string; label: string; closed?: boolean }): Promise<LinearIssue[]> {
    return [...this.issuesById.values()]
      .filter((i) => i.closed === (o.closed ?? false) && i.team === o.team && (o.project === undefined || i.project === o.project))
      .map((i) => this.toIssue(i))
      .filter((i) => i.labels.includes(o.label))
  }

  async issue(id: string): Promise<LinearIssue> {
    return this.toIssue(this.find(id))
  }

  async labels(team: string): Promise<{ id: string; name: string }[]> {
    const hidden = new Set(this.unlisted)
    this.unlisted.clear()
    return this.labelList
      .filter((l) => (l.team === null || l.team === team) && !hidden.has(l.name))
      .map(({ id, name }) => ({ id, name }))
  }

  async createLabel(team: string, name: string): Promise<{ id: string; name: string }> {
    if (this.labelList.some((l) => l.name === name && (l.team === null || l.team === team))) {
      throw new Error(`Label ${name} already exists`)
    }
    const { id } = this.defineLabel(name, team)
    return { id, name }
  }

  async addLabel(issueId: string, labelId: string): Promise<void> {
    const issue = this.find(issueId)
    if (!this.labelList.some((l) => l.id === labelId)) throw new Error(`No label ${labelId}`)
    if (!issue.labelIds.includes(labelId)) issue.labelIds.push(labelId)
  }

  async removeLabel(issueId: string, labelId: string): Promise<void> {
    const issue = this.find(issueId)
    issue.labelIds = issue.labelIds.filter((l) => l !== labelId)
  }

  async comments(issueId: string): Promise<{ id: string; body: string; authorId: string | null }[]> {
    return this.commentsOn(issueId).map(({ id, body, authorId }) => ({ id, body, authorId }))
  }

  async createComment(issueId: string, body: string): Promise<void> {
    this.addComment(issueId, body, RUMBA_USER)
  }

  async updateComment(commentId: string, body: string): Promise<void> {
    const c = this.commentList.find((x) => x.id === commentId)
    if (!c) throw new Error(`No comment ${commentId}`)
    c.body = body
  }

  async documents(issueId: string): Promise<LinkedDocument[]> {
    return this.find(issueId).documents.map((d) => ({ ...d }))
  }

  /** Finds an issue by UUID or identifier, as the Linear API does. */
  private find(id: string): StoredIssue {
    const issue = this.issuesById.get(id) ?? [...this.issuesById.values()].find((i) => i.identifier === id)
    if (!issue) throw new Error(`No issue ${id}`)
    return issue
  }

  private labelNamed(name: string, team: string): StoredLabel {
    return this.labelList.find((l) => l.name === name && (l.team === null || l.team === team)) ?? this.defineLabel(name, null)
  }

  private toIssue(i: StoredIssue): LinearIssue {
    return {
      id: i.id, identifier: i.identifier, title: i.title, description: i.description,
      url: `https://linear.app/acme/issue/${i.identifier}`, labels: this.labelNamesOf(i.id), open: !i.closed,
    }
  }

  private newId(kind: string): string {
    return `${kind}-${this.next++}`
  }
}

export function memoryGateway(): MemoryLinearGateway {
  return new MemoryLinearGateway()
}
