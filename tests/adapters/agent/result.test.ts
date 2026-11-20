import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESULT_PATH } from '../../../src/adapters/agent/prompts.js'
import { readAgentResult } from '../../../src/adapters/agent/result.js'
import { AgentError } from '../../../src/ports/agent.js'

let dir: string

async function writeRaw(content: string): Promise<void> {
  const file = path.join(dir, RESULT_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

async function writeResult(value: unknown): Promise<void> {
  await writeRaw(JSON.stringify(value))
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rumba-result-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('readAgentResult', () => {
  it('reads a valid result', async () => {
    await writeResult({ kind: 'fix', summary: 'done' }); expect(await readAgentResult(dir, 'fix')).toEqual({ kind: 'fix', summary: 'done' })
  })

  it('reads each other result kind', async () => {
    const criteria = [{ id: 'c1', text: 'Login works', checkable: true }]
    await writeResult({ kind: 'triage', workable: true, reason: 'clear', ticketKind: 'bug', criteria })
    expect(await readAgentResult(dir, 'triage')).toEqual({ kind: 'triage', workable: true, reason: 'clear', ticketKind: 'bug', criteria })
    await writeResult({ kind: 'triage', workable: false, reason: 'vague', ticketKind: 'feature', criteria: null })
    expect(await readAgentResult(dir, 'triage')).toEqual({ kind: 'triage', workable: false, reason: 'vague', ticketKind: 'feature', criteria: null })
    await writeResult({ kind: 'draft-criteria', criteria })
    expect(await readAgentResult(dir, 'draft-criteria')).toEqual({ kind: 'draft-criteria', criteria })
    const checks = [{ criterionId: 'c1', command: 'npx vitest run tests/rumba/login.test.ts', files: ['tests/rumba/login.test.ts'] }]
    await writeResult({ kind: 'write-checks', checks })
    expect(await readAgentResult(dir, 'write-checks')).toEqual({ kind: 'write-checks', checks })
  })

  it.each([
    ['missing file', null, /did not write/],
    ['not json', '{ nope', /not valid JSON/],
    ['wrong kind', JSON.stringify({ kind: 'triage', workable: true, reason: '', ticketKind: 'bug', criteria: null }), /expected a "fix" result/],
    ['wrong shape', JSON.stringify({ kind: 'fix' }), /summary/],
  ])('throws AgentError for %s', async (_n, content, pattern) => {
    if (content !== null) await writeRaw(content)
    await expect(readAgentResult(dir, 'fix')).rejects.toThrow(AgentError); await expect(readAgentResult(dir, 'fix')).rejects.toThrow(pattern)
  })

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent segment', '../outside.test.ts'],
    ['a nested parent segment', 'tests/../../outside.test.ts'],
    ['a backslash', 'tests\\rumba\\a.test.ts'],
    ['an empty path', ''],
  ])('rejects a check file with %s', async (_n, file) => {
    await writeResult({ kind: 'write-checks', checks: [{ criterionId: 'c1', command: 'true', files: [file] }] })
    await expect(readAgentResult(dir, 'write-checks')).rejects.toThrow(AgentError)
    await expect(readAgentResult(dir, 'write-checks')).rejects.toThrow(/files/)
  })

  it('rejects an empty check command and empty criterion fields', async () => {
    await writeResult({ kind: 'write-checks', checks: [{ criterionId: 'c1', command: '', files: [] }] })
    await expect(readAgentResult(dir, 'write-checks')).rejects.toThrow(/command/)
    await writeResult({ kind: 'draft-criteria', criteria: [{ id: '', text: 'x', checkable: true }] })
    await expect(readAgentResult(dir, 'draft-criteria')).rejects.toThrow(/id/)
    await writeResult({ kind: 'draft-criteria', criteria: [{ id: 'c1', text: '', checkable: true }] })
    await expect(readAgentResult(dir, 'draft-criteria')).rejects.toThrow(/text/)
  })
})
