import { Octokit } from '@octokit/rest'

export interface StubRequest {
  method: string
  path: string
  query: URLSearchParams
  body: Record<string, unknown>
}

type Handler = (req: StubRequest, match: string[]) => unknown
type Route = { method: string; pattern: RegExp; handler: Handler }

export function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status })
}

/**
 * An Octokit whose every request is answered by the given routes, in memory.
 * A handler returns the response data, or `{ data, link }` to add a Link header.
 */
export function stubOctokit(routes: Route[]): { octokit: Octokit; requests: StubRequest[] } {
  const octokit = new Octokit()
  const requests: StubRequest[] = []
  octokit.hook.wrap('request', async (_request, options) => {
    const ep = octokit.request.endpoint(options)
    const url = new URL(ep.url)
    const body = typeof ep.body === 'string' ? JSON.parse(ep.body) : ((ep.body ?? {}) as Record<string, unknown>)
    const req: StubRequest = { method: ep.method, path: decodeURIComponent(url.pathname), query: url.searchParams, body }
    requests.push(req)
    for (const r of routes) {
      const m = r.method === req.method ? r.pattern.exec(req.path) : null
      if (!m) continue
      const out = r.handler(req, m.slice(1))
      if (out !== null && typeof out === 'object' && 'link' in out && 'data' in out) {
        const { data, link } = out as { data: unknown; link: string }
        return { status: 200, url: ep.url, headers: link ? { link } : {}, data }
      }
      return { status: 200, url: ep.url, headers: {}, data: out }
    }
    throw httpError(404, `No stub for ${req.method} ${req.path}`)
  })
  return { octokit, requests }
}

export function route(method: string, pattern: RegExp, handler: Handler): Route {
  return { method, pattern, handler }
}

export interface StoredIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: string[]
  pull_request?: object
}

export interface StoredComment {
  id: number
  issue: number
  body: string
  author_association: string
  user: { type: string }
}

/** Pages a list the way GitHub does: per_page (default 30) and page, with a rel="next" Link header. */
function paged<T>(req: StubRequest, items: T[]): { data: T[]; link: string } {
  const perPage = Number(req.query.get('per_page') ?? 30)
  const page = Number(req.query.get('page') ?? 1)
  const data = items.slice((page - 1) * perPage, page * perPage)
  const next = new URLSearchParams(req.query)
  next.set('page', String(page + 1))
  const link = page * perPage < items.length ? `<https://api.github.com${req.path}?${next}>; rel="next"` : ''
  return { data, link }
}

/** An in-memory GitHub repository: issues, labels and comments. */
export class GitHubStore {
  issues: StoredIssue[] = []
  labels: string[] = []
  /** Labels that exist but are missing from the label list, as when another run creates one after the list was read. */
  unlisted = new Set<string>()
  comments: StoredComment[] = []
  /** Comment ids whose edit is refused with a 403. */
  refuseEdits = new Set<number>()
  /** Who the API caller is, for comments it creates. */
  author = { author_association: 'OWNER', user: { type: 'User' } }
  private nextId = 1

  addIssue(o: Partial<Omit<StoredIssue, 'number'>> = {}): StoredIssue {
    const issue: StoredIssue = { number: this.nextId++, title: 'An issue', body: 'Body', state: 'open', labels: [], ...o }
    this.issues.push(issue)
    return issue
  }

  addComment(issue: number, body: string, author = this.author): StoredComment {
    const c: StoredComment = { id: this.nextId++, issue, body, ...structuredClone(author) }
    this.comments.push(c)
    return c
  }

  commentsOn(issue: number): StoredComment[] {
    return this.comments.filter((c) => c.issue === issue)
  }

  private issue(n: string): StoredIssue {
    const i = this.issues.find((x) => x.number === Number(n))
    if (!i) throw httpError(404)
    return i
  }

  private json(i: StoredIssue): object {
    return {
      number: i.number,
      title: i.title,
      body: i.body,
      state: i.state,
      html_url: `https://github.com/o/r/issues/${i.number}`,
      labels: i.labels.map((name) => ({ name })),
      ...(i.pull_request ? { pull_request: i.pull_request } : {}),
    }
  }

  routes(): Route[] {
    const repo = '/repos/o/r'
    return [
      route('GET', new RegExp(`^${repo}/issues$`), (req) => {
        const state = req.query.get('state') ?? 'open'
        const wanted = (req.query.get('labels') ?? '').split(',').filter(Boolean)
        const list = this.issues.filter((i) => (state === 'all' || i.state === state) && wanted.every((l) => i.labels.includes(l)))
        return paged(req, list.map((i) => this.json(i)))
      }),
      route('GET', new RegExp(`^${repo}/issues/(\\d+)$`), (_req, [n]) => this.json(this.issue(n!))),
      route('GET', new RegExp(`^${repo}/labels$`), (req) => paged(req, this.labels.map((name) => ({ name })))),
      route('POST', new RegExp(`^${repo}/labels$`), (req) => {
        const name = String(req.body.name)
        if ([...this.labels, ...this.unlisted].some((l) => l.toLowerCase() === name.toLowerCase())) throw httpError(422, 'Validation Failed: already_exists')
        this.labels.push(name)
        return { name }
      }),
      route('GET', new RegExp(`^${repo}/issues/(\\d+)/comments$`), (req, [n]) => {
        this.issue(n!)
        return paged(req, this.commentsOn(Number(n)).map((c) => structuredClone(c)))
      }),
      route('POST', new RegExp(`^${repo}/issues/(\\d+)/comments$`), (req, [n]) => {
        this.issue(n!)
        return this.addComment(Number(n), String(req.body.body))
      }),
      route('PATCH', new RegExp(`^${repo}/issues/comments/(\\d+)$`), (req, [id]) => {
        const c = this.comments.find((x) => x.id === Number(id))
        if (!c) throw httpError(404)
        if (this.refuseEdits.has(c.id)) throw httpError(403)
        c.body = String(req.body.body)
        return c
      }),
      route('POST', new RegExp(`^${repo}/issues/(\\d+)/labels$`), (req, [n]) => {
        const i = this.issue(n!)
        for (const l of req.body.labels as string[]) if (!i.labels.includes(l)) i.labels.push(l)
        return i.labels.map((name) => ({ name }))
      }),
      route('DELETE', new RegExp(`^${repo}/issues/(\\d+)/labels/(.+)$`), (_req, [n, name]) => {
        const i = this.issue(n!)
        if (!i.labels.includes(name!)) throw httpError(404, 'Label does not exist')
        i.labels = i.labels.filter((l) => l !== name)
        return i.labels.map((x) => ({ name: x }))
      }),
    ]
  }
}
