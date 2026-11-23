import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { loadRumbas } from '../../src/config/load.js'
import { initRumba } from '../../src/init/init.js'

let root: string

const read = (dir: string, file: string): Promise<string> => readFile(path.join(dir, file), 'utf8')

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rumba-init-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('initRumba', () => {
  it('creates the rumba folder and a managed workflow', async () => {
    const r = await initRumba(root, 'shop')
    expect(r.created).toEqual(expect.arrayContaining(['.rumba/shop/rumba.yml', '.rumba/shop/context.md', '.rumba/shop/lessons.md', '.github/workflows/rumba.yml']))
    expect((await loadRumbas(root))[0].name).toBe('shop')
    expect(r.notes.join('\n')).toContain('do not start this repository\'s own CI')
  })
  it('says what a person must set up before enabling the workflow, and keeps the CI note word for word', async () => {
    const { notes } = await initRumba(root, 'shop')
    expect(notes.join('\n')).toContain('${RUMBA_WORKDIR:-.}:/app')
    const text = notes.join('\n')
    expect(text).toContain('rumba-cli is not published to npm yet')
    expect(text).toContain('Do not enable the workflow until rumba-cli is published, or replace its "Run rumba" step with an install from a checkout of Rumba you trust.')
    expect(text).toContain('"Allow GitHub Actions to create and approve pull requests"')
    expect(notes).toContain(
      'Pull requests opened with the default GitHub Actions token do not start this repository\'s own CI. ' +
      'Set RUMBA_GITHUB_TOKEN to a fine-grained token or a GitHub App token to get CI on Rumba\'s pull requests.',
    )
  })
  it('explains the run step and the checkout credentials in the workflow', async () => {
    await initRumba(root, 'shop')
    const lines = (await read(root, '.github/workflows/rumba.yml')).split('\n')
    const runAt = lines.findIndex((l) => l.trim() === '- name: Run rumba')
    const above = lines.slice(0, runAt).reverse()
    const comment = above.slice(0, above.findIndex((l) => !l.trim().startsWith('#'))).reverse().join('\n')
    expect(comment).toContain('not published to npm yet'); expect(comment).toContain('a checkout of Rumba you trust')
    const checkoutAt = lines.findIndex((l) => l.includes('uses: actions/checkout@'))
    expect(lines.slice(0, checkoutAt).join('\n')).toMatch(/persist-credentials[\s\S]*Rumba fetches the default branch/)
    const job = Object.values(parse(lines.join('\n')).jobs)[0] as { steps: { uses?: string; with?: Record<string, unknown> }[] }
    expect(job.steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with).not.toHaveProperty('persist-credentials')
  })
  it('adds a second rumba to the managed workflow matrix', async () => {
    await initRumba(root, 'shop'); await initRumba(root, 'api')
    expect(await read(root, '.github/workflows/rumba.yml')).toMatch(/rumba:\s*\[\s*shop,\s*api\s*\]/)
  })
  it('refuses an existing name and an invalid one', async () => {
    await initRumba(root, 'shop'); await expect(initRumba(root, 'shop')).rejects.toThrow(/already exists/)
    await expect(initRumba(root, 'Bad_Name')).rejects.toThrow(/lowercase letters, digits and hyphens/)
  })
  it('writes a workflow that matches the brief', async () => {
    await initRumba(root, 'shop')
    const text = await read(root, '.github/workflows/rumba.yml')
    const wf = parse(text)
    expect(text.startsWith('# managed by rumba init')).toBe(true)
    expect(wf.on.schedule).toEqual([{ cron: '*/30 * * * *' }])
    expect(wf.on).toHaveProperty('workflow_dispatch')
    const job = Object.values(wf.jobs)[0] as Record<string, any>
    expect(job.strategy.matrix.rumba).toEqual(['shop'])
    expect(job.concurrency).toEqual({ group: 'rumba-${{ matrix.rumba }}', 'cancel-in-progress': false })
    expect(job['timeout-minutes']).toBe(120)
    expect(job.permissions).toEqual({ contents: 'write', issues: 'write', 'pull-requests': 'write' })
    const run = job.steps.find((s: { run?: string }) => s.run)
    expect(run.run).toBe('npx rumba-cli run --name ${{ matrix.rumba }}')
    expect(Object.keys(run.env).sort()).toEqual([
      'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'RUMBA_GITHUB_LOGIN', 'RUMBA_GITHUB_TOKEN',
      'VERCEL_AUTOMATION_BYPASS_SECRET', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'VERCEL_TOKEN',
    ])
    // The only expression inside any run script is the validated rumba name.
    for (const step of job.steps as { run?: string }[]) {
      expect((step.run ?? '').replaceAll('${{ matrix.rumba }}', '')).not.toContain('${{')
    }
  })
  it('leaves a workflow it did not create alone and says to add the name by hand', async () => {
    await mkdir(path.join(root, '.github/workflows'), { recursive: true })
    await writeFile(path.join(root, '.github/workflows/rumba.yml'), 'name: mine\n')
    const r = await initRumba(root, 'shop')
    expect(r.created).not.toContain('.github/workflows/rumba.yml')
    expect(await read(root, '.github/workflows/rumba.yml')).toBe('name: mine\n')
    expect(r.notes.join('\n')).toMatch(/add "shop" to .*by hand/)
  })
  it('lists every limit in the starter rumba.yml with its default, max_review_rounds included', async () => {
    await initRumba(root, 'shop')
    const text = await read(root, '.rumba/shop/rumba.yml')
    const shown = Object.fromEntries([...text.matchAll(/^# {3}(\w+): (\d+)$/gm)].map((m) => [m[1], Number(m[2])]))
    expect(shown).toEqual({ max_tickets_per_run: 3, minutes_per_ticket: 30, max_fix_attempts: 2, max_review_rounds: 2 })
  })
  it('starts context.md and lessons.md with a line saying what they are for', async () => {
    await initRumba(root, 'shop')
    expect((await read(root, '.rumba/shop/context.md')).trim()).not.toBe('')
    expect((await read(root, '.rumba/shop/lessons.md')).trim()).not.toBe('')
  })
})
