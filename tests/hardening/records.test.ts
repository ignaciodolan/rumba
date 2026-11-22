import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCliAgent } from '../../src/adapters/agent/cliRun.js'
import { RESULT_PATH } from '../../src/adapters/agent/prompts.js'
import { FileRunRecords, recordingAgent } from '../../src/adapters/records.js'
import { AgentError, type AgentTask } from '../../src/ports/agent.js'
import { FakeAgent, makeTicket } from '../../src/testing/fakes.js'
import { mkdir, writeFile } from 'node:fs/promises'

// A record of each agent call, kept where a person can find it after the run, without keys.

let dir: string
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'rumba-records-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const fixTask: AgentTask = { kind: 'fix', ticket: makeTicket({ id: '18', ref: '#18' }), context: '', environmentKind: 'docker', attempt: 2 }

describe('the transcript of an agent call', () => {
  it('keeps the last part of what the CLI printed with the result', async () => {
    const sandbox = { run: async (o: { workdir: string }) => {
      await mkdir(path.join(o.workdir, '.rumba-out'), { recursive: true })
      await writeFile(path.join(o.workdir, RESULT_PATH), JSON.stringify({ kind: 'fix', summary: 'done' }))
      return { exitCode: 0, output: 'a'.repeat(30_000) + 'I changed src/slug.js.' }
    } }
    const r = await runCliAgent({ sandbox, name: 'X', command: ['x'], env: {}, timeoutMs: 1000, task: fixTask, workdir: dir })
    expect(r.transcript?.endsWith('I changed src/slug.js.')).toBe(true)
    expect(r.transcript!.length).toBeLessThanOrEqual(20_000)
  })
})

describe('recordingAgent', () => {
  it('writes one file per call, by ticket, task and attempt, with the summary and the transcript, and no keys', async () => {
    const inner = new FakeAgent()
    inner.script.fix = { kind: 'fix', summary: 'Lower-cased the slug using sk-secret-1.', transcript: 'thinking… token sk-secret-1 … done' }
    const records = new FileRunRecords(path.join(dir, 'run-1'))
    const agent = recordingAgent(inner, records, ['sk-secret-1'])
    await agent.run(fixTask, '/w')
    const files = await readdir(path.join(dir, 'run-1', '18'))
    expect(files).toEqual(['01-fix-attempt-2.md'])
    const text = await readFile(path.join(dir, 'run-1', '18', files[0]!), 'utf8')
    expect(text).toContain('Lower-cased the slug using [redacted].')
    expect(text).toContain('thinking… token [redacted] … done')
    expect(text).not.toContain('sk-secret-1')
  })
  it('records a call that failed, then rethrows its error', async () => {
    const inner = new FakeAgent(); inner.script.triage = new AgentError('Claude Code exited with code 1:\nrate limited')
    const records = new FileRunRecords(path.join(dir, 'run-2'))
    await expect(recordingAgent(inner, records, []).run({ ...fixTask, kind: 'triage', attempt: undefined }, '/w')).rejects.toThrow('rate limited')
    const text = await readFile(path.join(dir, 'run-2', '18', '01-triage.md'), 'utf8')
    expect(text).toContain('rate limited')
  })
  it('keeps the files private to the user', async () => {
    const inner = new FakeAgent(); inner.script.fix = { kind: 'fix', summary: 's' }
    const records = new FileRunRecords(path.join(dir, 'run-3'))
    await recordingAgent(inner, records, []).run(fixTask, '/w')
    const { stat } = await import('node:fs/promises')
    expect((await stat(path.join(dir, 'run-3'))).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(dir, 'run-3', '18', '01-fix-attempt-2.md'))).mode & 0o777).toBe(0o600)
  })
})
