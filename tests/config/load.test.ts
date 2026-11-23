import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorkspace } from '../../src/adapters/workspace/git.js'
import { loadRumba, loadRumbas } from '../../src/config/load.js'

const minimal = `
paths: ["apps/shop/**"]
tracker: { kind: github }
agent: { kind: claude-code }
environment: { kind: docker, up: "docker compose up -d --wait", exec: "docker compose exec -T app", down: "docker compose down -v" }
`

let root: string

async function write(relativePath: string, content: string): Promise<void> {
  const full = path.join(root, relativePath)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content)
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rumba-config-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('loadRumbas', () => {
  it('loads a minimal docker rumba with defaults', async () => {
    await write('.rumba/shop/rumba.yml', minimal)
    await write('.rumba/shop/context.md', 'Shop is the storefront.')
    await write('.rumba/shop/lessons.md', '- Use pnpm.')
    const [r] = await loadRumbas(root)
    expect(r.name).toBe('shop')
    expect(r.dir).toBe(path.join(root, '.rumba', 'shop'))
    expect(r.limits).toEqual({ maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 2, maxReviewRounds: 2 })
    expect(r.labels.optIn).toBe('rumba:shop')
    expect(r.environment).toMatchObject({ kind: 'docker', protected: ['docker-compose*.y*ml', 'compose*.y*ml', 'Dockerfile*', '*.dockerfile', '.dockerignore'] })
    expect(r.context).toContain('Shop is the storefront.')
    expect(r.context).toContain('- Use pnpm.')
  })
  it('rejects an invalid folder name', async () => {
    await write('.rumba/Hub_1/rumba.yml', 'tracker: { kind: github }')
    await expect(loadRumbas(root)).rejects.toThrow(/Hub_1.*lowercase letters, digits and hyphens/)
  })
  it('requires a team for linear', async () => {
    await write('.rumba/shop/rumba.yml', minimal.replace('kind: github', 'kind: linear'))
    await expect(loadRumbas(root)).rejects.toThrow(/shop.*tracker\.team/)
  })
  it('reports a missing .rumba folder', async () => {
    await expect(loadRumbas(root)).rejects.toThrow(/No rumbas found.*rumba init/)
  })
  it('reports a .rumba folder with no rumbas', async () => {
    await write('.rumba/readme.txt', 'x')
    await expect(loadRumbas(root)).rejects.toThrow(/No rumbas found.*rumba init/)
  })
  it('reports a rumba folder without rumba.yml', async () => {
    await mkdir(path.join(root, '.rumba', 'shop'), { recursive: true })
    await expect(loadRumbas(root)).rejects.toThrow(/^shop.*rumba\.yml/)
  })
  it('reads limits.max_review_rounds, and ignores unknown keys', async () => {
    await write('.rumba/shop/rumba.yml', `${minimal}limits: { max_review_rounds: 5, max_fix_attempts: 4 }\nsomething_else: 1\n`)
    const [r] = await loadRumbas(root)
    expect(r.limits).toEqual({ maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 4, maxReviewRounds: 5 })
  })
  it.each(['0', '1.5', '-1', '"two"'])('rejects limits.max_review_rounds: %s', async (v) => {
    await write('.rumba/shop/rumba.yml', `${minimal}limits: { max_review_rounds: ${v} }\n`)
    await expect(loadRumbas(root)).rejects.toThrow()
  })
  it('maps snake_case keys, labels and vercel-preview defaults', async () => {
    await write('.rumba/web/rumba.yml', `
paths: ["web/**"]
tracker: { kind: linear, team: ENG, project: Web }
agent: { kind: gemini-cli, model: gemini-x }
environment: { kind: vercel-preview, project_id: prj_1 }
verify: { test: "npm test" }
limits: { max_tickets_per_run: 5, minutes_per_ticket: 10 }
labels: { opt_in: auto, approved: ok }
`)
    const [r] = await loadRumbas(root)
    expect(r.tracker).toEqual({ kind: 'linear', team: 'ENG', project: 'Web' })
    expect(r.agent).toEqual({ kind: 'gemini-cli', model: 'gemini-x' })
    expect(r.environment).toEqual({ kind: 'vercel-preview', projectId: 'prj_1', protected: [] })
    expect(r.verify).toEqual({ test: 'npm test' })
    expect(r.limits).toEqual({ maxTicketsPerRun: 5, minutesPerTicket: 10, maxFixAttempts: 2, maxReviewRounds: 2 })
    expect(r.labels).toEqual({ optIn: 'auto', statePrefix: 'rumba-state:', approved: 'ok', retry: 'rumba-retry', revise: 'rumba-revise' })
    expect(r.context).toBe('')
  })
  it('lets rumba.yml rename the revise label', async () => {
    await write('.rumba/shop/rumba.yml', minimal + 'labels: { revise: needs-work }\n')
    const [r] = await loadRumbas(root)
    expect(r.labels.revise).toBe('needs-work')
  })
  it('prefixes schema errors with the rumba name and YAML path', async () => {
    await write('.rumba/shop/rumba.yml', minimal.replace('claude-code', 'nope'))
    await expect(loadRumbas(root)).rejects.toThrow(/^shop: agent\.kind/)
  })
  it('joins context and lessons, skipping empty files', async () => {
    await write('.rumba/shop/rumba.yml', minimal)
    await write('.rumba/shop/context.md', '  A  \n')
    await write('.rumba/shop/lessons.md', '\n')
    expect((await loadRumbas(root))[0].context).toBe('A')
  })
})

describe('loadRumba', () => {
  it('names the rumbas that do exist', async () => {
    await write('.rumba/shop/rumba.yml', minimal)
    await expect(loadRumba(root, 'api')).rejects.toThrow(/No rumba named "api".*shop/)
  })
  it('loads one rumba by name', async () => {
    await write('.rumba/shop/rumba.yml', minimal)
    expect((await loadRumba(root, 'shop')).name).toBe('shop')
  })
})

describe('lessons in the context', () => {
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const r = await execa('git', ['-c', 'user.name=rumba', '-c', 'user.email=rumba@users.noreply.github.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdin: 'ignore' })
    return r.stdout.trim()
  }

  it('holds a lesson committed on a branch only once it is on the default branch', async () => {
    const remote = path.join(root, 'remote.git')
    await mkdir(remote); await git(remote, 'init', '-q', '--bare')
    await git(root, 'clone', '-q', remote, 'repo')
    const repo = path.join(root, 'repo')
    await mkdir(path.join(repo, '.rumba', 'shop'), { recursive: true })
    await writeFile(path.join(repo, '.rumba/shop/rumba.yml'), minimal)
    await writeFile(path.join(repo, '.rumba/shop/context.md'), 'Shop is the storefront.')
    await git(repo, 'add', '-A'); await git(repo, 'commit', '-q', '-m', 'add the shop rumba')
    await git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main'); await git(repo, 'fetch', '-q', 'origin')

    // The lesson as Rumba commits it: on a branch of its own, in a worktree of its own.
    const ws = new GitWorkspace({ repoRoot: repo, defaultBranch: 'main' })
    try {
      const { workdir } = await ws.prepare('rumba/shop/lesson-42', { fresh: true })
      await ws.commitFile(workdir, '.rumba/shop/lessons.md', '- Round order totals in the service.\n  From https://example.test/pr/42\n', 'docs: lesson from review of #42')
    } finally {
      await ws.cleanupAll()
    }
    expect((await loadRumba(repo, 'shop')).context).toBe('Shop is the storefront.')

    await git(repo, 'merge', '-q', '--ff-only', 'rumba/shop/lesson-42')
    expect((await loadRumba(repo, 'shop')).context).toBe('Shop is the storefront.\n\n- Round order totals in the service.\n  From https://example.test/pr/42')
  })
})
