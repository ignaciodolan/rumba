import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadRumba, loadRumbas } from '../../src/config/load.js'

const minimal = `
paths: ["apps/hub/**"]
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
    await write('.rumba/hub/rumba.yml', minimal)
    await write('.rumba/hub/context.md', 'Hub is the admin app.')
    await write('.rumba/hub/lessons.md', '- Use pnpm.')
    const [r] = await loadRumbas(root)
    expect(r.name).toBe('hub')
    expect(r.dir).toBe(path.join(root, '.rumba', 'hub'))
    expect(r.limits).toEqual({ maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 2 })
    expect(r.labels.optIn).toBe('rumba:hub')
    expect(r.environment).toMatchObject({ kind: 'docker', protected: ['docker-compose*.y*ml', 'compose*.y*ml'] })
    expect(r.context).toContain('Hub is the admin app.')
    expect(r.context).toContain('- Use pnpm.')
  })
  it('rejects an invalid folder name', async () => {
    await write('.rumba/Hub_1/rumba.yml', 'tracker: { kind: github }')
    await expect(loadRumbas(root)).rejects.toThrow(/Hub_1.*lowercase letters, digits and hyphens/)
  })
  it('requires a team for linear', async () => {
    await write('.rumba/hub/rumba.yml', minimal.replace('kind: github', 'kind: linear'))
    await expect(loadRumbas(root)).rejects.toThrow(/hub.*tracker\.team/)
  })
  it('reports a missing .rumba folder', async () => {
    await expect(loadRumbas(root)).rejects.toThrow(/No rumbas found.*rumba init/)
  })
  it('reports a .rumba folder with no rumbas', async () => {
    await write('.rumba/readme.txt', 'x')
    await expect(loadRumbas(root)).rejects.toThrow(/No rumbas found.*rumba init/)
  })
  it('reports a rumba folder without rumba.yml', async () => {
    await mkdir(path.join(root, '.rumba', 'hub'), { recursive: true })
    await expect(loadRumbas(root)).rejects.toThrow(/^hub.*rumba\.yml/)
  })
  it('ignores unknown keys such as limits.max_review_rounds', async () => {
    await write('.rumba/hub/rumba.yml', `${minimal}limits: { max_review_rounds: 5, max_fix_attempts: 4 }\nsomething_else: 1\n`)
    const [r] = await loadRumbas(root)
    expect(r.limits).toEqual({ maxTicketsPerRun: 3, minutesPerTicket: 30, maxFixAttempts: 4 })
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
    expect(r.limits).toEqual({ maxTicketsPerRun: 5, minutesPerTicket: 10, maxFixAttempts: 2 })
    expect(r.labels).toEqual({ optIn: 'auto', statePrefix: 'rumba-state:', approved: 'ok', retry: 'rumba-retry' })
    expect(r.context).toBe('')
  })
  it('prefixes schema errors with the rumba name and YAML path', async () => {
    await write('.rumba/hub/rumba.yml', minimal.replace('claude-code', 'nope'))
    await expect(loadRumbas(root)).rejects.toThrow(/^hub: agent\.kind/)
  })
  it('joins context and lessons, skipping empty files', async () => {
    await write('.rumba/hub/rumba.yml', minimal)
    await write('.rumba/hub/context.md', '  A  \n')
    await write('.rumba/hub/lessons.md', '\n')
    expect((await loadRumbas(root))[0].context).toBe('A')
  })
})

describe('loadRumba', () => {
  it('names the rumbas that do exist', async () => {
    await write('.rumba/hub/rumba.yml', minimal)
    await expect(loadRumba(root, 'api')).rejects.toThrow(/No rumba named "api".*hub/)
  })
  it('loads one rumba by name', async () => {
    await write('.rumba/hub/rumba.yml', minimal)
    expect((await loadRumba(root, 'hub')).name).toBe('hub')
  })
})
