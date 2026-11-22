import { afterEach, describe, expect, it } from 'vitest'
import { buildProgram, type CliOverrides } from '../src/cli.js'
import { ConfigError } from '../src/config/load.js'
import type { RunSummary } from '../src/core/runner.js'
import { makeDeps, makeRumba } from '../src/testing/fakes.js'
import { MissingKeyError } from '../src/wiring.js'

afterEach(() => {
  process.exitCode = undefined
})

function harness(overrides: CliOverrides = {}) {
  const out: string[] = []; const err: string[] = []
  const p = buildProgram({ out: (s) => out.push(s), err: (s) => err.push(s) }, {
    cwd: '/repo',
    env: {},
    repoRoot: async () => '/repo',
    remoteUrl: async () => 'https://github.com/acme/shop.git',
    defaultBranch: async () => 'main',
    loadRumbas: async () => [makeRumba()],
    loadRumba: async (_root, name) => makeRumba({ name }),
    buildDeps: () => makeDeps(),
    ...overrides,
  })
  p.exitOverride()
  return { p, out, err, parse: (...args: string[]) => p.parseAsync(['node', 'rumba', ...args]) }
}

describe('rumba', () => {
  it('rejects --ticket without --name', async () => {
    const err: string[] = []; const p = buildProgram({ out: () => {}, err: s => err.push(s) }); p.exitOverride()
    await expect(p.parseAsync(['node', 'rumba', 'run', '--ticket', '5'])).rejects.toThrow(); expect(err.join('')).toContain('--ticket needs --name')
  })

  it('lists run, status and init in --help', async () => {
    const h = harness()
    await expect(h.parse('--help')).rejects.toThrow()
    const help = h.out.join('')
    for (const c of ['run', 'status', 'init']) expect(help).toMatch(new RegExp(`^\\s+${c}\\b`, 'm'))
  })

  it('prints where the records of the agent calls are, when there are any', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const path = await import('node:path')
    const dir = await mkdtemp(path.join(tmpdir(), 'rumba-cli-records-'))
    try {
      const summary: RunSummary = { rumba: 'hub', advanced: [], left: [] }
      const h = harness({ runRumba: async () => summary, recordsDir: () => dir })
      await h.parse('run', '--name', 'hub')
      expect(h.out).toContain(`Agent records: ${dir}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it('prints one line per ticket from the run summary', async () => {
    const summary: RunSummary = { rumba: 'hub', advanced: [{ ticket: '12', from: 'queued', to: 'pr_open' }], left: [{ ticket: '13', why: 'awaiting criteria' }] }
    const h = harness({ runRumba: async () => summary })
    await h.parse('run')
    expect(h.out).toEqual(['hub 12 queued → pr_open', 'hub 13 left: awaiting criteria'])
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('passes --name and --ticket through to one rumba', async () => {
    const calls: { rumba: string; ticketId?: string }[] = []
    const h = harness({
      loadRumbas: async () => { throw new Error('should not load every rumba') },
      runRumba: async (_d, rumba, opts) => { calls.push({ rumba: rumba.name, ...opts }); return { rumba: rumba.name, advanced: [], left: [] } },
    })
    await h.parse('run', '--name', 'api', '--ticket', '7')
    expect(calls).toEqual([{ rumba: 'api', ticketId: '7' }])
  })

  it('keeps going when one rumba fails and exits 1', async () => {
    const ran: string[] = []
    const h = harness({
      env: { ANTHROPIC_API_KEY: 'sk-secret' },
      loadRumbas: async () => [makeRumba({ name: 'api' }), makeRumba({ name: 'hub' }), makeRumba({ name: 'web' })],
      buildDeps: (rumba) => {
        if (rumba.name === 'api') throw new MissingKeyError(`LINEAR_API_KEY is not set. Rumba "api" uses the linear tracker.`)
        return makeDeps()
      },
      runRumba: async (_d, rumba) => {
        if (rumba.name === 'hub') throw new Error('boom with sk-secret inside')
        ran.push(rumba.name); return { rumba: rumba.name, advanced: [], left: [] }
      },
    })
    await h.parse('run')
    expect(ran).toEqual(['web'])
    expect(h.err).toHaveLength(2)
    expect(h.err[0]).toMatch(/^api: LINEAR_API_KEY is not set/)
    expect(h.err[1]).toBe('hub: boom with [redacted] inside')
    expect(process.exitCode).toBe(1)
  })


  it('fails the whole command on a ConfigError', async () => {
    let ran = false
    const h = harness({
      loadRumbas: async () => { throw new ConfigError('hub: paths: Required') },
      runRumba: async () => { ran = true; return { rumba: 'hub', advanced: [], left: [] } },
    })
    await h.parse('run')
    expect(ran).toBe(false)
    expect(h.err.join('\n')).toContain('hub: paths: Required')
    expect(process.exitCode).toBe(1)
  })

  it('prints status lines with queued for a ticket without state', async () => {
    const h = harness({
      buildTracker: () => makeDeps().tracker,
      listStatus: async () => [
        { ref: '#12', state: 'building', title: 'Login fails' },
        { ref: '#13', state: 'queued', title: 'Typo on home page' },
      ],
    })
    await h.parse('status')
    expect(h.out).toEqual(['hub #12 building Login fails', 'hub #13 queued Typo on home page'])
  })

  it('reads queued from a tracker that has no state for the ticket', async () => {
    const deps = makeDeps()
    deps.tracker.tickets.push({ id: '13', ref: '#13', title: 'Typo', body: '', url: 'u', labels: ['rumba:hub'] })
    const h = harness({ buildTracker: () => deps.tracker })
    await h.parse('status')
    expect(h.out).toEqual(['hub #13 queued Typo'])
  })
})
