import type { Agent, AgentResult, AgentTask } from '../../ports/agent.js'
import type { Sandbox } from '../../ports/sandbox.js'
import { runCliAgent } from './cliRun.js'
import { buildPrompt } from './prompts.js'

export class ClaudeCodeAgent implements Agent {
  constructor(private readonly o: { sandbox: Sandbox; apiKey: string; model?: string; timeoutMs: number }) {}

  async run(task: AgentTask, workdir: string): Promise<AgentResult> {
    const command = ['claude', '-p', buildPrompt(task), '--dangerously-skip-permissions']
    if (this.o.model !== undefined) command.push('--model', this.o.model)
    return runCliAgent({
      sandbox: this.o.sandbox,
      name: 'Claude Code',
      command,
      env: { ANTHROPIC_API_KEY: this.o.apiKey },
      timeoutMs: this.o.timeoutMs,
      task,
      workdir,
    })
  }
}
