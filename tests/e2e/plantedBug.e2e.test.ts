import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEnvironment, shellRunner } from '../../src/adapters/environment/docker.js'
import { GitWorkspace } from '../../src/adapters/workspace/git.js'
import { loadRumba, type RumbaConfig } from '../../src/config/load.js'
import { runRumba } from '../../src/core/runner.js'
import type { Agent, AgentResult, AgentTask } from '../../src/ports/agent.js'
import type { Deps } from '../../src/ports/deps.js'
import { FakeCodeHost, FakeTracker } from '../../src/testing/fakes.js'

const FIXTURE = fileURLToPath(new URL('../../fixtures/planted-bug', import.meta.url))
const BOT = ['-c', 'user.name=Rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

function canRun(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}

const dockerAvailable = canRun('docker', ['info']) && canRun('docker', ['compose', 'version'])

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', [...BOT, ...args], { cwd, stdin: 'ignore' })).stdout.trim()
}

async function containersOf(project: string): Promise<string[]> {
  const r = await execa('docker', ['ps', '-a', '-q', '--filter', `label=com.docker.compose.project=${project}`], { stdin: 'ignore' })
  return r.stdout.split('\n').filter((l) => l !== '')
}

/** Edits files in the workdir it is given, and only there. No model is called. */
class ScriptedAgent implements Agent {
  workdirs = new Set<string>()

  async run(task: AgentTask, workdir: string): Promise<AgentResult> {
    this.workdirs.add(workdir)
    switch (task.kind) {
      case 'triage':
        return {
          kind: 'triage', workable: true, reason: '', ticketKind: 'bug',
          criteria: [{ id: 'c1', text: "slugify('Hello World') returns 'hello-world'", checkable: true }],
        }
      case 'write-checks': {
        const check = [
          "import { test } from 'node:test'",
          "import assert from 'node:assert/strict'",
          "import { slugify } from '../src/slug.js'",
          '',
          "test('slugify lower-cases the slug', () => {",
          "  assert.equal(slugify('Hello World'), 'hello-world')",
          '})',
          '',
        ].join('\n')
        await writeFile(path.join(workdir, 'test', 'rumba-c1.test.js'), check)
        return { kind: 'write-checks', checks: [{ criterionId: 'c1', command: 'node --test test/rumba-c1.test.js', files: ['test/rumba-c1.test.js'] }] }
      }
      case 'fix': {
        const file = path.join(workdir, 'src', 'slug.js')
        const before = await readFile(file, 'utf8')
        const after = before.replace(".join('-')", ".join('-').toLowerCase()")
        if (after === before) throw new Error('scripted fix found nothing to change in src/slug.js')
        await writeFile(file, after)
        return { kind: 'fix', summary: 'Lower-case the slug.' }
      }
      default:
        throw new Error(`scripted agent has no answer for ${task.kind}`)
    }
  }
}

describe(dockerAvailable ? 'planted bug, end to end' : 'planted bug, end to end (skipped: Docker with compose is not available)', () => {
  let tmp: string
  let repoRoot: string
  let rumba: RumbaConfig
  let tracker: FakeTracker
  let codeHost: FakeCodeHost
  let agent: ScriptedAgent
  /** Every checkout of a commit under test that the environment was given. */
  let envWorkdirs: Set<string>
  /** Every directory a host-side command (`up`, `exec`, `down`) ran in. */
  let hostDirs: Set<string>
  /** Every compose project name Rumba gave those commands. */
  let projects: Set<string>
  let deps: Deps

  async function commitToMain(message: string): Promise<void> {
    await git(repoRoot, 'add', '-A')
    await git(repoRoot, 'commit', '-q', '-m', message)
    await git(repoRoot, 'push', '-q', 'origin', 'main')
  }

  async function fixSlugOnMain(): Promise<void> {
    const file = path.join(repoRoot, 'src', 'slug.js')
    await writeFile(file, (await readFile(file, 'utf8')).replace(".join('-')", ".join('-').toLowerCase()"))
    await commitToMain('fix: lower-case slugs')
  }

  /** Real git and real Docker for `config`; the tracker, the code host and the agent are stand-ins. */
  function depsFor(config: RumbaConfig, scripted: ScriptedAgent): Deps {
    if (config.environment.kind !== 'docker') throw new Error('the fixture rumba must use the docker environment')
    const { up, exec, down } = config.environment
    const workspace = new GitWorkspace({ repoRoot, defaultBranch: 'main' })
    const environment = new DockerEnvironment({
      up, exec, down, trusted: workspace,
      run: (command, o) => { hostDirs.add(o.cwd); projects.add(o.env?.COMPOSE_PROJECT_NAME ?? ''); return shellRunner(command, o) },
    })
    const realUp = environment.up.bind(environment)
    environment.up = async (ref, workdir) => { envWorkdirs.add(workdir); return realUp(ref, workdir) }
    return { tracker, agent: scripted, codeHost, environment, workspace, clock: () => new Date(), runId: 'e2e', secrets: [] }
  }

  beforeEach(async () => {
    if (!dockerAvailable) return
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-e2e-')))
    repoRoot = path.join(tmp, 'repo')
    const origin = path.join(tmp, 'origin.git')
    await cp(FIXTURE, repoRoot, { recursive: true })
    await git(repoRoot, 'init', '-q', '-b', 'main')
    await git(repoRoot, 'add', '-A')
    await git(repoRoot, 'commit', '-q', '-m', 'chore: planted bug fixture')
    await mkdir(origin)
    await git(origin, 'init', '-q', '--bare', '-b', 'main')
    await git(repoRoot, 'remote', 'add', 'origin', origin)
    await git(repoRoot, 'push', '-q', '-u', 'origin', 'main')

    rumba = await loadRumba(repoRoot, 'demo')
    tracker = new FakeTracker(rumba.labels)
    tracker.tickets.push({
      id: '1', ref: '#1', title: 'Slugs keep upper-case letters', body: "slugify('Hello World') returns 'Hello-World'; slugs should be lower-case.",
      url: 'https://example.test/issues/1', labels: [rumba.labels.optIn],
    })
    codeHost = new FakeCodeHost()
    agent = new ScriptedAgent()
    envWorkdirs = new Set()
    hostDirs = new Set()
    projects = new Set()
    deps = depsFor(rumba, agent)
  })

  afterEach(async () => {
    if (!dockerAvailable) return
    const problems: string[] = []
    for (const project of projects ?? []) {
      if ((await containersOf(project)).length > 0) {
        problems.push(`compose project ${project} still has containers`)
        await execa('docker', ['compose', '-p', project, 'down', '-v', '--rmi', 'local', '--remove-orphans'], { stdin: 'ignore', reject: false })
      }
    }
    for (const workdir of [...(agent?.workdirs ?? []), ...(envWorkdirs ?? []), ...(hostDirs ?? [])]) {
      if (existsSync(workdir)) {
        problems.push(`workdir ${workdir} was not removed`)
        await rm(workdir, { recursive: true, force: true })
      }
    }
    if (existsSync(path.join(repoRoot, '.git'))) {
      const worktrees = (await git(repoRoot, 'worktree', 'list', '--porcelain')).split('\n').filter((l) => l.startsWith('worktree '))
      if (worktrees.length !== 1) problems.push(`worktrees left registered: ${worktrees.join(', ')}`)
    }
    await rm(tmp, { recursive: true, force: true })
    expect(problems).toEqual([])
  })

  it.skipIf(!dockerAvailable)('takes the planted bug from queued to pr_open with real git and docker', async () => {
    const r = await runRumba(deps, rumba)
    expect(r.advanced).toEqual([{ ticket: '1', from: 'queued', to: 'pr_open' }])
    const s = tracker.states.get('1')!
    expect(s.before).toEqual([expect.objectContaining({ criterionId: 'c1', passed: false })])
    expect(s.after).toEqual([expect.objectContaining({ criterionId: 'c1', passed: true })])
    expect(codeHost.prs[0].body).toContain('| fail | pass |'); expect(codeHost.prs[0].draft).toBe(false)
    // The before-run and the after-run each got their own checkout of the commit, never where an agent wrote.
    expect(envWorkdirs.size).toBe(2)
    for (const w of envWorkdirs) expect(agent.workdirs.has(w)).toBe(false)
    // The host-side commands ran somewhere else again: each in its own checkout of the default
    // branch (up, one check and down before; up, one check, the project tests and down after).
    expect(hostDirs.size).toBe(7)
    expect(projects.size).toBe(2)
    for (const d of hostDirs) { expect(agent.workdirs.has(d)).toBe(false); expect(envWorkdirs.has(d)).toBe(false) }
  }, 300_000)

  it.skipIf(!dockerAvailable)('never lets a commit under test change what runs on the host', async () => {
    // A person's project: `up` goes through a script, and the compose file includes another file.
    const escape = path.join(tmp, 'host-dir')
    await mkdir(escape)
    await mkdir(path.join(repoRoot, 'scripts'))
    await writeFile(path.join(repoRoot, 'scripts', 'up.sh'), '#!/bin/sh\nexec docker compose up -d --wait --build\n')
    await writeFile(path.join(repoRoot, 'services.yml'), await readFile(path.join(repoRoot, 'docker-compose.yml'), 'utf8'))
    await writeFile(path.join(repoRoot, 'docker-compose.yml'), 'include:\n  - services.yml\n')
    await commitToMain('chore: start through a script and an included file')

    // An agent that follows instructions hidden in a ticket: both of its commits rewrite the
    // script, the included compose file and the Dockerfile. With `protected: []` the guard
    // is out of the way, so only the rule about where host commands run stands between
    // these files and the host.
    class HostileAgent extends ScriptedAgent {
      async run(task: AgentTask, workdir: string): Promise<AgentResult> {
        const result = await super.run(task, workdir)
        if (task.kind === 'write-checks' || task.kind === 'fix') {
          await writeFile(path.join(workdir, 'scripts', 'up.sh'), `#!/bin/sh\ntouch '${path.join(escape, 'script-ran-on-host')}'\nexit 1\n`)
          await writeFile(path.join(workdir, 'services.yml'), [
            'services:', '  app:', '    build: .', '    volumes:', '      - ${RUMBA_WORKDIR:-.}:/app', `      - ${escape}:/escape`,
            "    command: sh -c 'touch /escape/included-file-was-read; sleep infinity'", '',
          ].join('\n'))
          await writeFile(path.join(workdir, 'Dockerfile'), 'FROM node:22\nWORKDIR /app\nRUN touch /dockerfile-was-read\n')
        }
        return result
      }
    }
    agent = new HostileAgent()
    const config: RumbaConfig = {
      ...rumba,
      environment: { kind: 'docker', up: 'sh scripts/up.sh', exec: 'docker compose exec -T app', down: 'docker compose down -v --rmi local --remove-orphans', protected: [], commandTimeoutMinutes: 10 },
      // Fails if the image was built from the agent's Dockerfile.
      verify: { test: 'test ! -e /dockerfile-was-read && node --test' },
    }
    deps = depsFor(config, agent)

    const r = await runRumba(deps, config)

    expect(r.advanced).toEqual([{ ticket: '1', from: 'queued', to: 'pr_open' }])
    expect(existsSync(path.join(escape, 'script-ran-on-host'))).toBe(false)
    expect(existsSync(path.join(escape, 'included-file-was-read'))).toBe(false)
    const s = tracker.states.get('1')!
    expect(s.before).toEqual([expect.objectContaining({ criterionId: 'c1', passed: false })])
    expect(s.after).toEqual([expect.objectContaining({ criterionId: 'c1', passed: true })])
    for (const d of hostDirs) { expect(agent.workdirs.has(d)).toBe(false); expect(envWorkdirs.has(d)).toBe(false) }
  }, 300_000)

  it.skipIf(!dockerAvailable)('reports not_reproducible when the bug is already fixed', async () => {
    await fixSlugOnMain(); const r = await runRumba(deps, rumba)
    expect(r.advanced[0].to).toBe('not_reproducible'); expect(codeHost.prs).toHaveLength(0)
  }, 300_000)
})
