import type { Octokit } from '@octokit/rest'
import { renderCriteriaComment } from '../../core/criteria.js'
import { stateLabel } from '../../core/labels.js'
import { decodeStateComment, encodeStateComment } from '../../core/stateComment.js'
import type { Criterion, LabelNames, LinkedDocument, StateName, Ticket, TicketState } from '../../core/types.js'
import type { Tracker } from '../../ports/tracker.js'

const PER_PAGE = 100
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

interface IssueData {
  number: number
  title: string
  body?: string | null
  html_url: string
  labels: (string | { name?: string })[]
}

interface CommentData {
  id: number
  body?: string
  author_association?: string
  user: { type: string } | null
}

function httpStatus(e: unknown): number | undefined {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : undefined
}

/**
 * Comments on a public repository are untrusted: anyone could forge a state comment.
 * Only comments by owners, members, collaborators or bots are read.
 */
function isTrusted(c: CommentData): boolean {
  return TRUSTED_ASSOCIATIONS.has(c.author_association ?? '') || c.user?.type === 'Bot'
}

function labelNames(labels: IssueData['labels']): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.name)).filter((l): l is string => typeof l === 'string')
}

function toTicket(i: IssueData): Ticket {
  return { id: String(i.number), ref: `#${i.number}`, title: i.title, body: i.body ?? '', url: i.html_url, labels: labelNames(i.labels) }
}

function noteLine(key: string): string {
  return `rumba-note: ${key}`
}

export class GitHubTracker implements Tracker {
  private readonly octokit: Octokit
  private readonly owner: string
  private readonly repo: string
  private readonly labels: LabelNames
  private readonly stateNames: StateName[]

  constructor(o: { octokit: Octokit; owner: string; repo: string; labels: LabelNames; stateNames: StateName[] }) {
    this.octokit = o.octokit
    this.owner = o.owner
    this.repo = o.repo
    this.labels = o.labels
    this.stateNames = o.stateNames
  }

  async ensureLabels(): Promise<void> {
    const existing = await this.octokit.paginate(this.octokit.rest.issues.listLabelsForRepo, { ...this.where(), per_page: PER_PAGE })
    // GitHub label names are case-insensitive.
    const have = new Set(existing.map((l) => l.name.toLowerCase()))
    const wanted = [...this.stateNames.map((s) => stateLabel(this.labels, s)), this.labels.approved, this.labels.retry]
    for (const name of wanted) {
      if (have.has(name.toLowerCase())) continue
      try {
        await this.octokit.rest.issues.createLabel({ ...this.where(), name })
      } catch (e) {
        // 422 already_exists: another run created it after the list was read.
        if (httpStatus(e) !== 422) throw e
      }
    }
  }

  async listCandidates(): Promise<Ticket[]> {
    const issues = await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
      ...this.where(), state: 'open', labels: this.labels.optIn, per_page: PER_PAGE,
    })
    return issues.filter((i) => !i.pull_request).map((i) => toTicket(i))
  }

  async getTicket(id: string): Promise<Ticket> {
    const { data } = await this.octokit.rest.issues.get({ ...this.where(), issue_number: issueNumber(id) })
    return toTicket(data)
  }

  async readState(t: Ticket): Promise<TicketState | null> {
    return (await this.findState(t))?.state ?? null
  }

  async writeState(t: Ticket, s: TicketState): Promise<void> {
    const body = encodeStateComment(s)
    const found = await this.findState(t)
    let edited = false
    if (found) {
      try {
        await this.octokit.rest.issues.updateComment({ ...this.where(), comment_id: found.commentId, body })
        edited = true
      } catch (e) {
        const status = httpStatus(e)
        if (status !== 403 && status !== 404) throw e
      }
    }
    if (!edited) await this.comment(t, body)

    // Single add and remove calls, so a label a person adds meanwhile is kept.
    // The new label goes on first, so the ticket always carries a state label.
    const want = stateLabel(this.labels, s.state)
    const others = new Set(this.stateNames.map((n) => stateLabel(this.labels, n)).filter((l) => l !== want))
    const current = (await this.getTicket(t.id)).labels
    if (!current.includes(want)) await this.octokit.rest.issues.addLabels({ ...this.where(), issue_number: issueNumber(t.id), labels: [want] })
    for (const label of current) if (others.has(label)) await this.dropLabel(t, label)
    t.labels = [...t.labels.filter((l) => !others.has(l) && l !== want), want]
  }

  async postCriteria(t: Ticket, c: Criterion[]): Promise<void> {
    await this.comment(t, renderCriteriaComment(c, this.labels))
  }

  async readLinkedDocuments(_t: Ticket): Promise<LinkedDocument[]> {
    return []
  }

  async removeLabel(t: Ticket, label: string): Promise<void> {
    await this.dropLabel(t, label)
    t.labels = t.labels.filter((l) => l !== label)
  }

  async comment(t: Ticket, body: string): Promise<void> {
    await this.octokit.rest.issues.createComment({ ...this.where(), issue_number: issueNumber(t.id), body })
  }

  async commentOnce(t: Ticket, key: string, body: string): Promise<void> {
    const line = noteLine(key)
    const comments = await this.trustedComments(t)
    if (comments.some((c) => (c.body ?? '').split(/\r?\n/).some((l) => l.trim() === line))) return
    await this.comment(t, `${body}\n\n${line}`)
  }

  private where(): { owner: string; repo: string } {
    return { owner: this.owner, repo: this.repo }
  }

  /** Removes a label from the issue; a label that is already gone is success. */
  private async dropLabel(t: Ticket, name: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({ ...this.where(), issue_number: issueNumber(t.id), name })
    } catch (e) {
      if (httpStatus(e) !== 404) throw e
    }
  }

  private async trustedComments(t: Ticket): Promise<CommentData[]> {
    const all = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.where(), issue_number: issueNumber(t.id), per_page: PER_PAGE,
    })
    return all.filter(isTrusted)
  }

  /** The last trusted comment that holds a valid state. */
  private async findState(t: Ticket): Promise<{ commentId: number; state: TicketState } | null> {
    const comments = await this.trustedComments(t)
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i]!
      const state = decodeStateComment(c.body ?? '')
      if (state) return { commentId: c.id, state }
    }
    return null
  }
}

function issueNumber(id: string): number {
  if (!/^[1-9]\d*$/.test(id)) throw new Error(`Not a GitHub issue number: ${id}`)
  return Number(id)
}
