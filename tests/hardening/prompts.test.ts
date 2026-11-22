import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../../src/adapters/agent/prompts.js'
import { readAgentResult } from '../../src/adapters/agent/result.js'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { makeTicket } from '../../src/testing/fakes.js'

const base = { ticket: makeTicket(), context: '', environmentKind: 'docker' as const, criteria: [{ id: 'c1', text: 'C1', checkable: true }, { id: 'c2', text: 'C2', checkable: true }], checks: [] }

describe('the fix prompt says the true situation', () => {
  it('says which checks pass, which fail, and that only the project tests failed', () => {
    const p = buildPrompt({ ...base, kind: 'fix', checkStatus: [{ criterionId: 'c1', passed: true }, { criterionId: 'c2', passed: true }], projectTests: 'failed' })
    expect(p).toContain('Checks that pass now: c1, c2.')
    expect(p).toContain('Every check passes. Only the project\'s own tests failed.')
    expect(p).toContain('"noChangeNeeded"')
  })
  it('lists the failing checks when some fail', () => {
    const p = buildPrompt({ ...base, kind: 'fix', checkStatus: [{ criterionId: 'c1', passed: true }, { criterionId: 'c2', passed: false }], projectTests: 'not-run' })
    expect(p).toContain('Checks that fail now: c2.')
    expect(p).not.toContain('Only the project\'s own tests failed')
  })
  it('says plainly that the agent\'s sandbox is not the project\'s environment', () => {
    for (const kind of ['write-checks', 'fix'] as const) {
      const p = buildPrompt({ ...base, kind, execPrefix: 'docker compose exec -T app' })
      expect(p).toContain("Your sandbox is not the project's environment")
    }
  })
})

describe('a fix result may say no change is needed', () => {
  it('reads noChangeNeeded with its reason', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rumba-nochange-'))
    try {
      await mkdir(path.join(dir, '.rumba-out'))
      await writeFile(path.join(dir, '.rumba-out/result.json'), JSON.stringify({ kind: 'fix', summary: 's', noChangeNeeded: 'the code is right' }))
      expect(await readAgentResult(dir, 'fix')).toMatchObject({ noChangeNeeded: 'the code is right' })
      await writeFile(path.join(dir, '.rumba-out/result.json'), JSON.stringify({ kind: 'fix', summary: 's', noChangeNeeded: '' }))
      await expect(readAgentResult(dir, 'fix')).rejects.toThrow(/noChangeNeeded/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
