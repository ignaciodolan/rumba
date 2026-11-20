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
    const r = await initRumba(root, 'hub')
    expect(r.created).toEqual(expect.arrayContaining(['.rumba/hub/rumba.yml', '.rumba/hub/context.md', '.rumba/hub/lessons.md', '.github/workflows/rumba.yml']))
    expect((await loadRumbas(root))[0].name).toBe('hub')
    expect(r.notes.join('\n')).toContain('do not start this repository\'s own CI')
  })
  it('adds a second rumba to the managed workflow matrix', async () => {
    await initRumba(root, 'hub'); await initRumba(root, 'api')
    expect(await read(root, '.github/workflows/rumba.yml')).toMatch(/rumba:\s*\[\s*hub,\s*api\s*\]/)
  })
  it('refuses an existing name and an invalid one', async () => {
    await initRumba(root, 'hub'); await expect(initRumba(root, 'hub')).rejects.toThrow(/already exists/)
    await expect(initRumba(root, 'Bad_Name')).rejects.toThrow(/lowercase letters, digits and hyphens/)
  })
  it('writes a workflow that matches the brief', async () => {
    await initRumba(root, 'hub')
    const text = await read(root, '.github/workflows/rumba.yml')
    const wf = parse(text)
    expect(text.startsWith('# managed by rumba init')).toBe(true)
    expect(wf.on.schedule).toEqual([{ cron: '*/30 * * * *' }])
    expect(wf.on).toHaveProperty('workflow_dispatch')
    const job = Object.values(wf.jobs)[0] as Record<string, any>
    expect(job.strategy.matrix.rumba).toEqual(['hub'])
    expect(job.concurrency).toEqual({ group: 'rumba-${{ matrix.rumba }}', 'cancel-in-progress': false })
    expect(job['timeout-minutes']).toBe(120)
    expect(job.permissions).toEqual({ contents: 'write', issues: 'write', 'pull-requests': 'write' })
    const run = job.steps.find((s: { run?: string }) => s.run)
    expect(run.run).toBe('npx rumba-cli run --name ${{ matrix.rumba }}')
    expect(Object.keys(run.env).sort()).toEqual([
      'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GITHUB_TOKEN', 'LINEAR_API_KEY', 'RUMBA_GITHUB_LOGIN', 'RUMBA_GITHUB_TOKEN',
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
    const r = await initRumba(root, 'hub')
    expect(r.created).not.toContain('.github/workflows/rumba.yml')
    expect(await read(root, '.github/workflows/rumba.yml')).toBe('name: mine\n')
    expect(r.notes.join('\n')).toMatch(/add "hub" to .*by hand/)
  })
  it('starts context.md and lessons.md with a line saying what they are for', async () => {
    await initRumba(root, 'hub')
    expect((await read(root, '.rumba/hub/context.md')).trim()).not.toBe('')
    expect((await read(root, '.rumba/hub/lessons.md')).trim()).not.toBe('')
  })
})
