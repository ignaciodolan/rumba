#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Command, CommanderError } from 'commander'
import { execa } from 'execa'
import { ensureSandboxImage, SANDBOX_IMAGE } from './adapters/sandbox/docker.js'
import { ConfigError, loadRumba, loadRumbas, type RumbaConfig } from './config/load.js'
import { cleanOutput } from './core/redact.js'
import { runRumba, type RunSummary } from './core/runner.js'
import { initRumba } from './init/init.js'
import type { Deps } from './ports/deps.js'
import type { Tracker } from './ports/tracker.js'
import { buildDeps, buildTracker, parseRemote, secretValues } from './wiring.js'

export interface Io {
  out: (s: string) => void
  err: (s: string) => void
}

type Env = Record<string, string | undefined>

export interface StatusLine { ref: string; state: string; title: string }

/** The collaborators of the commands. Tests replace them; the defaults do the real thing. */
export interface CliOverrides {
  cwd?: string
  env?: Env
  repoRoot?: (cwd: string) => Promise<string>
  remoteUrl?: (root: string) => Promise<string>
  defaultBranch?: (root: string) => Promise<string>
  loadRumbas?: (root: string) => Promise<RumbaConfig[]>
  loadRumba?: (root: string, name: string) => Promise<RumbaConfig>
  buildDeps?: (rumba: RumbaConfig, env: Env, repo: { root: string; owner: string; name: string; defaultBranch: string }) => Deps
  buildTracker?: (rumba: RumbaConfig, env: Env, repo: { owner: string; name: string }) => Tracker
  runRumba?: (deps: Deps, rumba: RumbaConfig, opts: { ticketId?: string }) => Promise<RunSummary>
  listStatus?: (tracker: Tracker, rumba: RumbaConfig) => Promise<StatusLine[]>
  ensureSandboxImage?: (image: string, dockerfileDir: string) => Promise<void>
}

/** The package's sandbox folder; the same relative path from `src/` and from `dist/`. */
const SANDBOX_DIR = fileURLToPath(new URL('../sandbox', import.meta.url))

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const r = await execa('git', args, { cwd, reject: false })
  return r.exitCode === 0 ? r.stdout.trim() : undefined
}

async function gitRepoRoot(cwd: string): Promise<string> {
  const root = await git(cwd, ['rev-parse', '--show-toplevel'])
  if (root === undefined) throw new Error('Not inside a git repository. Run rumba from a clone of your project.')
  return root
}

async function gitRemoteUrl(root: string): Promise<string> {
  const url = await git(root, ['remote', 'get-url', 'origin'])
  if (url === undefined) throw new Error('This repository has no "origin" remote. Rumba needs one on github.com.')
  return url
}

async function gitDefaultBranch(root: string): Promise<string> {
  const local = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (local?.startsWith('origin/')) return local.slice('origin/'.length)
  const remote = await git(root, ['ls-remote', '--symref', 'origin', 'HEAD'])
  const m = remote === undefined ? null : /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote)
  if (m) return m[1]
  throw new Error(
    'Could not find the default branch of "origin". Run `git remote set-head origin --auto` and try again.',
  )
}

async function trackerStatus(tracker: Tracker, rumba: RumbaConfig): Promise<StatusLine[]> {
  const lines: StatusLine[] = []
  for (const t of await tracker.listCandidates()) {
    const s = await tracker.readState(t)
    lines.push({ ref: t.ref, state: s !== null && s.rumba === rumba.name ? s.state : 'queued', title: t.title })
  }
  return lines
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function buildProgram(io: Io, overrides: CliOverrides = {}): Command {
  const o = {
    cwd: process.cwd(),
    env: process.env,
    repoRoot: gitRepoRoot,
    remoteUrl: gitRemoteUrl,
    defaultBranch: gitDefaultBranch,
    loadRumbas,
    loadRumba,
    buildDeps,
    buildTracker,
    runRumba,
    listStatus: trackerStatus,
    ensureSandboxImage,
    ...overrides,
  }
  const secrets = secretValues(o.env)
  const fail = (line: string): void => {
    io.err(cleanOutput(line, secrets))
    process.exitCode = 1
  }

  /** Loads the rumbas the command is about; prints and returns null on any error. */
  async function setUp(name: string | undefined): Promise<{ root: string; owner: string; repo: string; rumbas: RumbaConfig[] } | null> {
    try {
      const root = await o.repoRoot(o.cwd)
      const { owner, name: repo } = parseRemote(await o.remoteUrl(root))
      const rumbas = name === undefined ? await o.loadRumbas(root) : [await o.loadRumba(root, name)]
      return { root, owner, repo, rumbas }
    } catch (e) {
      fail(e instanceof ConfigError ? `Config error: ${e.message}` : messageOf(e))
      return null
    }
  }

  const program = new Command('rumba')
    .description('Takes labelled tickets from an issue tracker to pull requests, with evidence.')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, '')),
      writeErr: (s) => io.err(s.replace(/\n$/, '')),
    })

  program
    .command('run')
    .description('Advance the tickets of every rumba, or of one')
    .option('--name <name>', 'run only this rumba')
    .option('--ticket <id>', 'run only this ticket (needs --name)')
    .action(async (opts: { name?: string; ticket?: string }) => {
      if (opts.ticket !== undefined && opts.name === undefined) program.error('--ticket needs --name')
      const setup = await setUp(opts.name)
      if (setup === null) return
      let defaultBranch: string
      try {
        defaultBranch = await o.defaultBranch(setup.root)
        await o.ensureSandboxImage(SANDBOX_IMAGE, SANDBOX_DIR)
      } catch (e) {
        return fail(messageOf(e))
      }
      const repo = { root: setup.root, owner: setup.owner, name: setup.repo, defaultBranch }
      for (const rumba of setup.rumbas) {
        try {
          const deps = o.buildDeps(rumba, o.env, repo)
          const summary = await o.runRumba(deps, rumba, opts.ticket === undefined ? {} : { ticketId: opts.ticket })
          for (const a of summary.advanced) io.out(`${summary.rumba} ${a.ticket} ${a.from} → ${a.to}`)
          for (const l of summary.left) io.out(`${summary.rumba} ${l.ticket} left: ${l.why}`)
        } catch (e) {
          fail(`${rumba.name}: ${messageOf(e)}`)
        }
      }
    })

  program
    .command('status')
    .description('List the tickets of every rumba, or of one, with their states')
    .option('--name <name>', 'only this rumba')
    .action(async (opts: { name?: string }) => {
      const setup = await setUp(opts.name)
      if (setup === null) return
      for (const rumba of setup.rumbas) {
        try {
          const tracker = o.buildTracker(rumba, o.env, { owner: setup.owner, name: setup.repo })
          for (const l of await o.listStatus(tracker, rumba)) io.out(`${rumba.name} ${l.ref} ${l.state} ${l.title}`)
        } catch (e) {
          fail(`${rumba.name}: ${messageOf(e)}`)
        }
      }
    })

  program
    .command('init')
    .description('Create .rumba/<name>/ and, if there is none, the scheduled GitHub Actions workflow')
    .argument('<name>', 'the rumba name: lowercase letters, digits and hyphens')
    .action(async (name: string) => {
      try {
        const r = await initRumba(await o.repoRoot(o.cwd), name)
        for (const file of r.created) io.out(`created ${file}`)
        for (const note of r.notes) io.out(note)
      } catch (e) {
        fail(messageOf(e))
      }
    })

  return program
}

function invokedDirectly(): boolean {
  const script = process.argv[1]
  if (script === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  const io: Io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }
  buildProgram(io)
    .parseAsync(process.argv)
    .catch((e: unknown) => {
      if (e instanceof CommanderError) {
        process.exitCode = e.exitCode
        return
      }
      io.err(cleanOutput(messageOf(e), secretValues(process.env)))
      process.exitCode = 1
    })
}
