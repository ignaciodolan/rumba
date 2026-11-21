import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GitHubTracker } from '../src/adapters/tracker/github.js'
import { LinearTracker } from '../src/adapters/tracker/linear.js'
import { GitHubCodeHost } from '../src/adapters/codeHost/github.js'
import { FakeCodeHost, FakeTracker, failing, makeDeps, makeRumba, makeTicket } from '../src/testing/fakes.js'
import { buildDeps, buildTracker, MissingKeyError, parseRemote, redactingCodeHost, redactingTracker, SANDBOX_DIR } from '../src/wiring.js'

const repo = { root: '/repo', owner: 'acme', name: 'shop', defaultBranch: 'main' }

const vercel = (projectId?: string) =>
  makeRumba({ environment: { kind: 'vercel-preview', protected: [], ...(projectId ? { projectId } : {}) } })

describe('buildDeps', () => {
  it('names the missing key and why', () => {
    expect(() => buildDeps(makeRumba({ agent: { kind: 'claude-code' } }), { RUMBA_GITHUB_TOKEN: 't' }, repo))
      .toThrow(/ANTHROPIC_API_KEY is not set, and neither is CLAUDE_CODE_OAUTH_TOKEN\. Rumba "hub" uses the claude-code agent\./)
  })
  it('accepts a Claude Code token from `claude setup-token` instead of an API key, and treats it as a secret', () => {
    const d = buildDeps(makeRumba(), { GITHUB_TOKEN: 'g', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-1' }, repo)
    expect(d.secrets).toContain('sk-ant-oat-1')
  })
  it('falls back to GITHUB_TOKEN and collects secrets', () => {
    const d = buildDeps(makeRumba(), { GITHUB_TOKEN: 'gh-1', ANTHROPIC_API_KEY: 'an-1' }, repo)
    expect(d.secrets.sort()).toEqual(['an-1', 'gh-1'])
  })
  it('throws MissingKeyError when no GitHub token is set', () => {
    expect(() => buildDeps(makeRumba(), { ANTHROPIC_API_KEY: 'a' }, repo)).toThrow(MissingKeyError)
    expect(() => buildDeps(makeRumba(), { ANTHROPIC_API_KEY: 'a', GITHUB_TOKEN: '' }, repo))
      .toThrow(/^RUMBA_GITHUB_TOKEN is not set.*GITHUB_TOKEN.*Rumba "hub"/)
  })
  it('asks for the key of the agent and tracker the rumba uses', () => {
    const env = { RUMBA_GITHUB_TOKEN: 't' }
    expect(() => buildDeps(makeRumba({ agent: { kind: 'gemini-cli' } }), env, repo))
      .toThrow(/GEMINI_API_KEY is not set\. Rumba "hub" uses the gemini-cli agent\./)
    expect(() => buildDeps(makeRumba({ tracker: { kind: 'linear', team: 'ENG' } }), { ...env, ANTHROPIC_API_KEY: 'a' }, repo))
      .toThrow(/LINEAR_API_KEY is not set\. Rumba "hub" uses the linear tracker\./)
  })
  it('asks for the Vercel token and a project id for vercel-preview', () => {
    const env = { RUMBA_GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'a' }
    expect(() => buildDeps(vercel('prj_1'), env, repo)).toThrow(/VERCEL_TOKEN is not set\. Rumba "hub" uses the vercel-preview environment/)
    expect(() => buildDeps(vercel(), { ...env, VERCEL_TOKEN: 'v' }, repo)).toThrow(/VERCEL_PROJECT_ID is not set\. Rumba "hub"/)
    expect(() => buildDeps(vercel('prj_1'), { ...env, VERCEL_TOKEN: 'v' }, repo)).not.toThrow()
    expect(() => buildDeps(vercel(), { ...env, VERCEL_TOKEN: 'v', VERCEL_PROJECT_ID: 'prj_2' }, repo)).not.toThrow()
  })
  it('keeps every set secret value, and no ids or login', () => {
    const d = buildDeps(vercel(), {
      RUMBA_GITHUB_TOKEN: 'r1', GITHUB_TOKEN: 'g1', ANTHROPIC_API_KEY: 'a1', GEMINI_API_KEY: '', LINEAR_API_KEY: 'l1',
      VERCEL_TOKEN: 'v1', VERCEL_PROJECT_ID: 'prj', VERCEL_TEAM_ID: 'team', VERCEL_AUTOMATION_BYPASS_SECRET: 'b1',
      RUMBA_GITHUB_LOGIN: 'bot',
    }, repo)
    expect(d.secrets.sort()).toEqual(['a1', 'b1', 'g1', 'l1', 'r1', 'v1'])
  })
})

describe('SANDBOX_DIR', () => {
  it("is the package's sandbox folder, which holds the image's Dockerfile", () => {
    expect(path.basename(SANDBOX_DIR)).toBe('sandbox')
    expect(existsSync(path.join(SANDBOX_DIR, 'Dockerfile'))).toBe(true)
  })
})

describe('buildTracker', () => {
  it('builds the tracker without the agent or Vercel keys', () => {
    expect(buildTracker(vercel(), { GITHUB_TOKEN: 'g' }, repo)).toBeInstanceOf(GitHubTracker)
    expect(buildTracker(makeRumba({ tracker: { kind: 'linear', team: 'ENG' } }), { GITHUB_TOKEN: 'g', LINEAR_API_KEY: 'l' }, repo))
      .toBeInstanceOf(LinearTracker)
  })
})

describe('parseRemote', () => {
  it('parses https and ssh remotes', () => {
    expect(parseRemote('https://github.com/acme/shop.git')).toEqual({ owner: 'acme', name: 'shop' })
    expect(parseRemote('git@github.com:acme/shop.git')).toEqual({ owner: 'acme', name: 'shop' })
  })
  it('parses ssh:// remotes and remotes without .git', () => {
    expect(parseRemote('ssh://git@github.com/acme/shop.git')).toEqual({ owner: 'acme', name: 'shop' })
    expect(parseRemote('https://github.com/acme/shop')).toEqual({ owner: 'acme', name: 'shop' })
    expect(parseRemote('git@github.com:acme/shop')).toEqual({ owner: 'acme', name: 'shop' })
    expect(parseRemote('https://x-access-token:abc@github.com/acme/my.shop.git')).toEqual({ owner: 'acme', name: 'my.shop' })
  })
  it('refuses remotes that are not on github.com', () => {
    for (const url of ['https://gitlab.com/acme/shop.git', 'git@github.example.com:acme/shop.git', '/srv/git/shop.git', 'https://github.com/acme']) {
      expect(() => parseRemote(url)).toThrow(/supports GitHub remotes only/)
    }
  })
})

describe('redacting wrappers', () => {
  const SECRET = 'tok-s3cret'

  it('buildDeps wraps the tracker and the code host', () => {
    const d = buildDeps(makeRumba(), { GITHUB_TOKEN: 'g', ANTHROPIC_API_KEY: 'a' }, repo)
    expect(d.tracker).not.toBeInstanceOf(GitHubTracker); expect(d.codeHost).not.toBeInstanceOf(GitHubCodeHost)
  })

  it('redacts comments, criteria and every string in the state', async () => {
    const inner = new FakeTracker(); const t = makeTicket(); inner.tickets.push(t)
    const tracker = redactingTracker(inner, [SECRET])
    await tracker.comment(t, `body ${SECRET}`)
    await tracker.commentOnce(t, 'k', `once ${SECRET}`)
    await tracker.commentOnce(t, 'k', 'again')
    expect(inner.comments.map((c) => c.body)).toEqual(['body [redacted]', 'once [redacted]'])
    await tracker.postCriteria(t, [{ id: 'c1', text: `uses ${SECRET}`, checkable: true }])
    expect(inner.criteriaPosts[0]!.criteria).toEqual([{ id: 'c1', text: 'uses [redacted]', checkable: true }])
    const s = failing(makeDeps())
    s.criteria[0]!.text = `criterion ${SECRET}`
    s.checks[0]!.command = `curl -H ${SECRET}`
    s.before![0]!.output = `out ${SECRET}`
    s.history.push({ state: 'checks_failing', at: 'now', note: `note ${SECRET}` })
    await tracker.writeState(t, s)
    const stored = JSON.stringify(inner.states.get('123'))
    expect(stored).not.toContain(SECRET); expect(stored).toContain('criterion [redacted]')
    expect(stored).toContain('curl -H [redacted]'); expect(stored).toContain('out [redacted]'); expect(stored).toContain('note [redacted]')
    expect(s.before![0]!.output).toBe(`out ${SECRET}`)
  })

  it('delegates every other tracker method, keeping label updates on the same ticket object', async () => {
    const inner = new FakeTracker(); const t = makeTicket({ labels: ['rumba:hub', 'rumba-approved'] }); inner.tickets.push(t)
    inner.documents = [{ title: 'Spec', body: 'd' }]
    const tracker = redactingTracker(inner, [SECRET])
    await tracker.ensureLabels()
    expect(await tracker.listCandidates()).toEqual([t])
    expect(await tracker.getTicket('123')).toBe(t)
    expect(await tracker.readLinkedDocuments(t)).toEqual([{ title: 'Spec', body: 'd' }])
    const copy = { ...t, labels: [...t.labels] }
    await tracker.removeLabel(copy, 'rumba-approved')
    expect(copy.labels).toEqual(['rumba:hub'])
    await tracker.writeState(copy, failing(makeDeps()))
    expect(copy.labels).toContain('rumba-state:checks_failing')
    expect(await tracker.readState(copy)).toMatchObject({ state: 'checks_failing' })
  })

  it('redacts the pull request title and body and delegates the rest', async () => {
    const inner = new FakeCodeHost(); const host = redactingCodeHost(inner, [SECRET])
    expect(await host.openPullRequest({ title: `t ${SECRET}`, body: `b ${SECRET}`, head: 'h', base: 'main', draft: false })).toBe('https://example.test/pr/1')
    expect(inner.prs[0]).toEqual({ title: 't [redacted]', body: 'b [redacted]', head: 'h', base: 'main', draft: false })
    expect(await host.defaultBranch()).toBe('main')
    await host.pushBranch('/w', 'rumba/hub/1', { force: true }); await host.deleteBranch('rumba/hub/base-1')
    expect(inner.pushed).toEqual([{ branch: 'rumba/hub/1', force: true }]); expect(inner.deleted).toEqual(['rumba/hub/base-1'])
  })
})

