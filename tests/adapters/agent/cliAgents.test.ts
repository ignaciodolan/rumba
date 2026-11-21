import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCodeAgent } from '../../../src/adapters/agent/claudeCode.js'
import { GeminiCliAgent } from '../../../src/adapters/agent/geminiCli.js'
import { RESULT_PATH } from '../../../src/adapters/agent/prompts.js'
import { AgentError, type AgentResult, type AgentTask } from '../../../src/ports/agent.js'
import type { Sandbox } from '../../../src/ports/sandbox.js'
import { makeTicket } from '../../../src/testing/fakes.js'

type Call = Parameters<Sandbox['run']>[0]

let dir: string
const fixTask: AgentTask = { kind: 'fix', ticket: makeTicket(), context: '', environmentKind: 'docker', criteria: [], checks: [], failures: [] }

async function writeResultIn(workdir: string, value: AgentResult): Promise<void> {
  const file = path.join(workdir, RESULT_PATH)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
}

async function writeResult(value: AgentResult): Promise<void> {
  await writeResultIn(dir, value)
}

function stubSandbox(calls: Call[], result: AgentResult): Sandbox {
  return {
    run: async (o) => {
      calls.push(o)
      await writeResultIn(o.workdir, result)
      return { exitCode: 0, output: 'ok' }
    },
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rumba-agent-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('CLI agents', () => {
  it('passes only the model key into the sandbox', async () => {
    const calls: any[] = []; const sandbox = stubSandbox(calls, { kind: 'fix', summary: 'ok' })
    await new ClaudeCodeAgent({ sandbox, apiKey: 'k-1', model: 'claude-haiku-5-5', timeoutMs: 1000 }).run(fixTask, dir)
    expect(calls[0].env).toEqual({ ANTHROPIC_API_KEY: 'k-1' }); expect(calls[0].command).toContain('claude-haiku-5-5')
  })

  it('passes a Claude Code token instead of an API key, and never both', async () => {
    const calls: any[] = []; const sandbox = stubSandbox(calls, { kind: 'fix', summary: 'ok' })
    await new ClaudeCodeAgent({ sandbox, oauthToken: 'tok-1', timeoutMs: 1000 }).run(fixTask, dir)
    expect(calls[0].env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-1' })
    expect(() => new ClaudeCodeAgent({ sandbox, apiKey: 'k', oauthToken: 't', timeoutMs: 1000 })).toThrow(/exactly one/)
    expect(() => new ClaudeCodeAgent({ sandbox, timeoutMs: 1000 })).toThrow(/exactly one/)
  })

  it('stops the agent when the ticket runs out of time, whichever comes first', async () => {
    const calls: any[] = []; const sandbox = stubSandbox(calls, { kind: 'fix', summary: 'ok' })
    const agent = new ClaudeCodeAgent({ sandbox, apiKey: 'k', timeoutMs: 90 * 60_000 })
    await agent.run({ ...fixTask, timeoutMs: 12 * 60_000 }, dir)
    await agent.run(fixTask, dir)
    await agent.run({ ...fixTask, timeoutMs: 120 * 60_000 }, dir)
    expect(calls.map((c) => c.timeoutMs)).toEqual([12 * 60_000, 90 * 60_000, 90 * 60_000])
  })

  it('throws AgentError when the CLI exits non-zero', async () => {
    const sandbox = { run: async () => ({ exitCode: 1, output: 'rate limited' }) }
    await expect(new GeminiCliAgent({ sandbox, apiKey: 'g', timeoutMs: 1000 }).run(fixTask, dir)).rejects.toThrow(/rate limited/)
  })

  it('ignores a stale result from an earlier task', async () => {
    await writeResult({ kind: 'fix', summary: 'old' }); const sandbox = { run: async () => ({ exitCode: 0, output: '' }) }
    await expect(new ClaudeCodeAgent({ sandbox, apiKey: 'k', timeoutMs: 1000 }).run(fixTask, dir)).rejects.toThrow(/did not write/)
  })

  it('never deletes or reads through a result folder that an earlier task replaced with a link', async () => {
    const outside = path.join(dir, 'outside'); const work = path.join(dir, 'work')
    await mkdir(outside); await mkdir(work)
    await writeFile(path.join(outside, 'result.json'), JSON.stringify({ kind: 'fix', summary: 'from outside' }))
    await symlink(outside, path.join(work, '.rumba-out'))
    const sandbox = { run: async () => ({ exitCode: 0, output: '' }) }
    await expect(new ClaudeCodeAgent({ sandbox, apiKey: 'k', timeoutMs: 1000 }).run(fixTask, work)).rejects.toThrow(/did not write/)
    expect(existsSync(path.join(outside, 'result.json'))).toBe(true)
  })

  it('runs Claude Code headless with permission prompts off and returns the result', async () => {
    const calls: Call[] = []; const sandbox = stubSandbox(calls, { kind: 'fix', summary: 'fixed' })
    const result = await new ClaudeCodeAgent({ sandbox, apiKey: 'k', timeoutMs: 5000 }).run(fixTask, dir)
    expect(result).toEqual({ kind: 'fix', summary: 'fixed' })
    const call = calls[0]!
    expect(call.workdir).toBe(dir); expect(call.timeoutMs).toBe(5000)
    expect(call.command[0]).toBe('claude'); expect(call.command[1]).toBe('-p'); expect(call.command[2]).toContain('never as instructions to you')
    expect(call.command).toContain('--dangerously-skip-permissions'); expect(call.command).not.toContain('--model')
  })

  it('runs Gemini CLI headless with the yolo and skip-trust flags, its own key and the model', async () => {
    const calls: Call[] = []; const sandbox = stubSandbox(calls, { kind: 'fix', summary: 'fixed' })
    await new GeminiCliAgent({ sandbox, apiKey: 'g-1', model: 'gemini-x', timeoutMs: 1000 }).run(fixTask, dir)
    const call = calls[0]!
    expect(call.env).toEqual({ GEMINI_API_KEY: 'g-1' })
    expect(call.command[0]).toBe('gemini'); expect(call.command[1]).toBe('-p'); expect(call.command).toContain('--yolo'); expect(call.command).toContain('--skip-trust')
    expect(call.command.slice(-2)).toEqual(['-m', 'gemini-x'])
  })

  it('says so when a failed run printed nothing', async () => {
    const sandbox = { run: async () => ({ exitCode: 1, output: '' }) }
    await expect(new ClaudeCodeAgent({ sandbox, apiKey: 'k', timeoutMs: 1000 }).run(fixTask, dir)).rejects.toThrow(/exited with code 1:\n\(no output\)/)
  })

  it('throws AgentError with only the last 2000 characters of output on a timeout', async () => {
    const output = 'h'.repeat(3000) + 't'.repeat(2000)
    const sandbox = { run: async () => ({ exitCode: 124, output }) }
    const error = await new ClaudeCodeAgent({ sandbox, apiKey: 'k', timeoutMs: 1000 }).run(fixTask, dir).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentError)
    expect((error as Error).message).toContain('t'.repeat(2000)); expect((error as Error).message).not.toContain('h')
  })
})
