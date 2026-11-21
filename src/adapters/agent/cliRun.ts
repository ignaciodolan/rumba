import { AgentError, type AgentResult, type AgentTask } from '../../ports/agent.js'
import type { Sandbox } from '../../ports/sandbox.js'
import { clearAgentResult, readAgentResult } from './result.js'

const OUTPUT_TAIL = 2000

/** Shared by the CLI agents: clear the old result, run the CLI in the sandbox, read the new result. */
export async function runCliAgent(o: {
  sandbox: Sandbox
  name: string
  command: string[]
  env: Record<string, string>
  timeoutMs: number
  task: AgentTask
  workdir: string
}): Promise<AgentResult> {
  await clearAgentResult(o.workdir)
  const { exitCode, output } = await o.sandbox.run({ workdir: o.workdir, command: o.command, env: o.env, timeoutMs: o.timeoutMs })
  if (exitCode !== 0) {
    const reason = exitCode === 124 ? `timed out after ${o.timeoutMs} ms` : `exited with code ${exitCode}`
    throw new AgentError(`${o.name} ${reason}:\n${output === '' ? '(no output)' : output.slice(-OUTPUT_TAIL)}`)
  }
  return readAgentResult(o.workdir, o.task.kind)
}
