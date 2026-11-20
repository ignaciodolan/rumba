import { describe, expect, it } from 'vitest'
import { GitHubTracker } from '../src/adapters/tracker/github.js'
import { LinearTracker } from '../src/adapters/tracker/linear.js'
import { makeRumba } from '../src/testing/fakes.js'
import { buildDeps, buildTracker, MissingKeyError, parseRemote } from '../src/wiring.js'

const repo = { root: '/repo', owner: 'acme', name: 'shop', defaultBranch: 'main' }

const vercel = (projectId?: string) =>
  makeRumba({ environment: { kind: 'vercel-preview', protected: [], ...(projectId ? { projectId } : {}) } })

describe('buildDeps', () => {
  it('names the missing key and why', () => {
    expect(() => buildDeps(makeRumba({ agent: { kind: 'claude-code' } }), { RUMBA_GITHUB_TOKEN: 't' }, repo))
      .toThrow(/ANTHROPIC_API_KEY is not set\. Rumba "hub" uses the claude-code agent\./)
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
