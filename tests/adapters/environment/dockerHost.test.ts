import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DockerEnvironment } from '../../../src/adapters/environment/docker.js'
import { GitWorkspace } from '../../../src/adapters/workspace/git.js'

// The docker environment's `up`, `exec` and `down` commands run on the host. These tests use
// real git and the real shell runner to show which files those host-side commands read when
// the commit under test changes them. No Docker daemon is needed: the commands are stand-ins
// that read or execute files by relative path, exactly as make, a script or compose would.

const BOT = ['-c', 'user.name=Rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null']
const BRANCH = 'rumba/hub/1'

function composeCli(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 20_000 })
    return true
  } catch {
    return false
  }
}
const hasCompose = composeCli()

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execa('git', [...BOT, ...args], { cwd, stdin: 'ignore' })).stdout.trim()
}

async function write(root: string, file: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await writeFile(path.join(root, file), content)
}

describe('docker environment: what the host-side commands read', () => {
  let tmp: string
  let repoRoot: string
  let ws: GitWorkspace
  /** A file outside every checkout that the stand-in commands append to. */
  let log: string

  /** Commits `files` to main as a person would, and pushes. */
  async function mergeToMain(files: Record<string, string>): Promise<void> {
    for (const [file, content] of Object.entries(files)) await write(repoRoot, file, content)
    await git(repoRoot, 'add', '-A')
    await git(repoRoot, 'commit', '-q', '-m', 'chore: project files')
    await git(repoRoot, 'push', '-q', 'origin', 'main')
  }

  /**
   * What the steps do around an agent: a new worktree of the branch, the agent's files, a
   * commit, the worktree removed, and a new checkout of the commit for the environment.
   */
  async function candidateWith(files: Record<string, string>, opts: { fresh: boolean }): Promise<{ workdir: string; sha: string }> {
    const agentDir = (await ws.prepare(BRANCH, { fresh: opts.fresh })).workdir
    for (const [file, content] of Object.entries(files)) await write(agentDir, file, content)
    const sha = await ws.commit(agentDir, 'agent change')
    await ws.cleanup(agentDir)
    const { workdir } = await ws.prepare(BRANCH, { fresh: false })
    return { workdir, sha: sha! }
  }

  function environment(commands: { up: string; exec?: string; down?: string }): DockerEnvironment {
    return new DockerEnvironment({ exec: 'sh -c \'exec "$@"\' exec', down: 'true', ...commands, trusted: ws })
  }

  const logged = async () => (existsSync(log) ? (await readFile(log, 'utf8')).split('\n').filter((l) => l !== '') : [])

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'rumba-host-')))
    repoRoot = path.join(tmp, 'repo')
    log = path.join(tmp, 'log')
    const origin = path.join(tmp, 'origin.git')
    await mkdir(repoRoot)
    await mkdir(origin)
    await git(origin, 'init', '-q', '--bare', '-b', 'main')
    await git(repoRoot, 'init', '-q', '-b', 'main')
    await write(repoRoot, 'README.md', 'project\n')
    await git(repoRoot, 'add', '-A')
    await git(repoRoot, 'commit', '-q', '-m', 'chore: first commit')
    await git(repoRoot, 'remote', 'add', 'origin', origin)
    await git(repoRoot, 'push', '-q', '-u', 'origin', 'main')
    ws = new GitWorkspace({ repoRoot, defaultBranch: 'main' })
  })

  afterEach(async () => {
    await ws.cleanupAll()
    await rm(tmp, { recursive: true, force: true })
  })

  it('(a) never executes a script that the commit under test changed', async () => {
    const script = (who: string) => `#!/bin/sh\nprintf '%s:${who}\\n' "$1" >> '${log}'\nshift\n[ "$#" -eq 0 ] || exec "$@"\n`
    await mergeToMain({ 'scripts/up.sh': script('trusted'), 'scripts/exec.sh': script('trusted'), 'scripts/down.sh': script('trusted') })
    const changed = { 'scripts/up.sh': script('AGENT'), 'scripts/exec.sh': script('AGENT'), 'scripts/down.sh': script('AGENT') }
    const env = environment({ up: 'sh scripts/up.sh up', exec: 'sh scripts/exec.sh exec', down: 'sh scripts/down.sh down' })

    // The before-run: the commit the check-writing agent produced.
    const before = await candidateWith(changed, { fresh: true })
    expect(await readFile(path.join(before.workdir, 'scripts/up.sh'), 'utf8')).toContain('AGENT')
    const h = await env.up({ branch: BRANCH, sha: before.sha, role: 'before' }, before.workdir)
    const check = await env.runCheck(h, { criterionId: 'c1', command: 'echo checked', files: [] })
    await env.down(h)
    await ws.cleanup(before.workdir)
    expect(check).toMatchObject({ passed: true, output: 'checked' })

    // The after-run: the commit the fixing agent produced.
    const after = await candidateWith({ 'src/fix.txt': 'fixed\n' }, { fresh: false })
    const h2 = await env.up({ branch: BRANCH, sha: after.sha, role: 'after' }, after.workdir)
    await env.runCommand(h2, 'echo tested')
    await env.down(h2)

    expect(await logged()).toEqual(['up:trusted', 'exec:trusted', 'down:trusted', 'up:trusted', 'exec:trusted', 'down:trusted'])
  })

  it('(b) never reads a file that a trusted file includes when the commit under test changed it', async () => {
    // `make`-style stand-in: the command reads an entry file and whatever that file names.
    const reader = 'while read -r f; do cat "$f"; done < includes.list >> ' + `'${log}'`
    await mergeToMain({ 'includes.list': 'services.yml\n', 'services.yml': 'services-file:trusted\n' })
    const env = environment({ up: reader })

    const c = await candidateWith({ 'services.yml': 'services-file:AGENT\n' }, { fresh: true })
    const h = await env.up({ branch: BRANCH, sha: c.sha, role: 'before' }, c.workdir)
    await env.down(h)

    expect(await logged()).toEqual(['services-file:trusted'])
  })

  it.skipIf(!hasCompose)('(b) docker compose resolves an included file from the trusted checkout and mounts the commit under test', async () => {
    const out = path.join(tmp, 'resolved.yml')
    const service = (mark: string, extra = '') => [
      'services:', '  app:', '    image: busybox', '    environment:', `      MARK: ${mark}`,
      '    volumes:', '      - ${RUMBA_WORKDIR:-.}:/app', extra, '',
    ].filter((l) => l !== '').join('\n') + '\n'
    await mergeToMain({ 'docker-compose.yml': 'include:\n  - services.yml\n', 'services.yml': service('trusted') })
    const env = environment({ up: `docker compose config > '${out}'` })

    const escape = path.join(tmp, 'host-dir')
    const c = await candidateWith({ 'services.yml': service('AGENT', `      - ${escape}:/escape`) }, { fresh: true })
    const h = await env.up({ branch: BRANCH, sha: c.sha, role: 'before' }, c.workdir)
    await env.down(h)

    const resolved = await readFile(out, 'utf8')
    expect(resolved).toContain('MARK: trusted')
    expect(resolved).not.toContain('AGENT')
    expect(resolved).not.toContain(escape)
    // The code under test reaches the container as a mount, and only as that.
    expect(resolved).toContain(`source: ${c.workdir}`)
  })

  it.skipIf(!hasCompose)('(c) docker compose can build the commit under test with the Dockerfile of the trusted checkout', async () => {
    const out = path.join(tmp, 'resolved.yml')
    const compose = ['services:', '  app:', '    build:', '      context: ${RUMBA_WORKDIR:-.}', '      dockerfile: ${PWD}/Dockerfile', ''].join('\n')
    await mergeToMain({ 'docker-compose.yml': compose, Dockerfile: 'FROM trusted\n' })
    const env = environment({ up: `docker compose config > '${out}'; printf '%s' "$PWD" > '${log}'` })

    const c = await candidateWith({ Dockerfile: 'FROM AGENT\n' }, { fresh: true })
    const h = await env.up({ branch: BRANCH, sha: c.sha, role: 'before' }, c.workdir)
    const [hostDir] = await logged()
    const resolved = await readFile(out, 'utf8')
    await env.down(h)

    expect(resolved).toContain(`context: ${c.workdir}`)
    expect(resolved).toContain(`dockerfile: ${path.join(hostDir, 'Dockerfile')}`)
    expect(hostDir).not.toBe(c.workdir)
  })

  it('(c) never reads a Dockerfile that the commit under test changed', async () => {
    // `docker build .` stand-in: the build reads the Dockerfile of the directory it runs in.
    await mergeToMain({ Dockerfile: 'FROM trusted\n' })
    const env = environment({ up: `cat Dockerfile >> '${log}'` })

    const c = await candidateWith({ Dockerfile: 'FROM AGENT\n' }, { fresh: true })
    const h = await env.up({ branch: BRANCH, sha: c.sha, role: 'before' }, c.workdir)
    await env.down(h)

    expect(await logged()).toEqual(['FROM trusted'])
  })

  it('stops when something rewrote the trusted checkout during the run, and takes the environment down from a clean one', async () => {
    const script = (who: string) => `#!/bin/sh\nprintf '%s:${who}\\n' "$1" >> '${log}'\nshift\n[ "$#" -eq 0 ] || exec "$@"\n`
    await mergeToMain({ 'scripts/up.sh': script('trusted'), 'scripts/exec.sh': script('trusted'), 'scripts/down.sh': script('trusted') })
    const env = environment({ up: 'sh scripts/up.sh up', exec: 'sh scripts/exec.sh exec', down: 'sh scripts/down.sh down' })
    const c = await candidateWith({ 'src/a.txt': 'x\n' }, { fresh: true })
    const h = await env.up({ branch: BRANCH, sha: c.sha, role: 'before' }, c.workdir)

    // What code in a container could do if the merged compose file mounted `.` read-write.
    await writeFile(path.join(h.hostDir!, 'scripts/exec.sh'), script('AGENT'))
    await writeFile(path.join(h.hostDir!, 'scripts/down.sh'), script('AGENT'))
    await writeFile(path.join(h.hostDir!, '.env'), 'COMPOSE_FILE=elsewhere.yml\n')

    await expect(env.runCheck(h, { criterionId: 'c1', command: 'echo checked', files: [] })).rejects.toThrow(/no longer matches its commit/)
    await env.down(h)

    expect(await logged()).toEqual(['up:trusted', 'down:trusted'])
    expect(existsSync(h.hostDir!)).toBe(false)
  })

  it('hands the commit under test to the commands as RUMBA_WORKDIR and runs them somewhere else', async () => {
    await mergeToMain({ 'app.txt': 'base\n' })
    const env = environment({ up: `printf '%s\\n%s\\n' "$PWD" "$RUMBA_WORKDIR" >> '${log}'; cat "$RUMBA_WORKDIR/app.txt" >> '${log}'` })

    const c = await candidateWith({ 'app.txt': 'candidate\n' }, { fresh: true })
    const h = await env.up({ branch: BRANCH, sha: c.sha, role: 'before' }, c.workdir)
    const [cwd, handed, content] = await logged()
    expect(handed).toBe(c.workdir)
    expect(cwd).not.toBe(c.workdir)
    expect(path.dirname(cwd)).not.toBe(path.dirname(c.workdir))
    expect(content).toBe('candidate')
    // The directory the commands run in holds the default branch's files, not the candidate's.
    expect(await readFile(path.join(cwd, 'app.txt'), 'utf8')).toBe('base\n')

    await env.down(h)
    expect(existsSync(cwd)).toBe(false)
  })
})
