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
  it('accepts 20 criteria of 500 characters and 20 checks with 2,000-character commands', async () => {
    const criteria = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, text: 'x'.repeat(500), checkable: true }))
    await writeResult({ kind: 'draft-criteria', criteria })
    await expect(readAgentResult(dir, 'draft-criteria')).resolves.toMatchObject({ criteria })
    const checks = Array.from({ length: 20 }, (_, i) => ({ criterionId: `c${i}`, command: 'y'.repeat(2000), files: [] }))
    await writeResult({ kind: 'write-checks', checks })
    await expect(readAgentResult(dir, 'write-checks')).resolves.toMatchObject({ checks })
  })

  it.each([
    ['21 drafted criteria', 'draft-criteria', { kind: 'draft-criteria', criteria: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, text: 't', checkable: true })) }],
    ['a drafted criterion of 501 characters', 'draft-criteria', { kind: 'draft-criteria', criteria: [{ id: 'c1', text: 'x'.repeat(501), checkable: true }] }],
    ['21 triage criteria', 'triage', { kind: 'triage', workable: true, reason: '', ticketKind: 'bug', criteria: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, text: 't', checkable: true })) }],
    ['a triage criterion of 501 characters', 'triage', { kind: 'triage', workable: true, reason: '', ticketKind: 'bug', criteria: [{ id: 'c1', text: 'x'.repeat(501), checkable: true }] }],
    ['21 checks', 'write-checks', { kind: 'write-checks', checks: Array.from({ length: 21 }, (_, i) => ({ criterionId: `c${i}`, command: 'true', files: [] })) }],
    ['a check command of 2,001 characters', 'write-checks', { kind: 'write-checks', checks: [{ criterionId: 'c1', command: 'y'.repeat(2001), files: [] }] }],
  ] as const)('rejects %s', async (_n, kind, value) => {
    await writeResult(value)
    await expect(readAgentResult(dir, kind)).rejects.toThrow(AgentError)
  })
  it('reads a triage criteriaSource and refuses an unknown one', async () => {
    const criteria = [{ id: 'c1', text: 'Login works', checkable: true }]
    for (const criteriaSource of ['written', 'derived'] as const) {
      await writeResult({ kind: 'triage', workable: true, reason: '', ticketKind: 'feature', criteria, criteriaSource })
      expect(await readAgentResult(dir, 'triage')).toMatchObject({ criteriaSource })
    }
    await writeResult({ kind: 'triage', workable: true, reason: '', ticketKind: 'feature', criteria, criteriaSource: 'mine' })
    await expect(readAgentResult(dir, 'triage')).rejects.toThrow(/criteriaSource/)
  })
})

