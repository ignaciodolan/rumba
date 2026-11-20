import type { Agent, AgentResult, AgentTask } from '../../ports/agent.js'
import type { Sandbox } from '../../ports/sandbox.js'
import { runCliAgent } from './cliRun.js'
import { buildPrompt } from './prompts.js'

export class GeminiCliAgent implements Agent {
  constructor(private readonly o: { sandbox: Sandbox; apiKey: string; model?: string; timeoutMs: number }) {}

  async run(task: AgentTask, workdir: string): Promise<AgentResult> {
    // --skip-trust: headless Gemini CLI refuses to run in a folder it has not been told to trust.
    const command = ['gemini', '-p', buildPrompt(task), '--yolo', '--skip-trust']
    if (this.o.model !== undefined) command.push('-m', this.o.model)
    return runCliAgent({
      sandbox: this.o.sandbox,
      name: 'Gemini CLI',
      command,
      env: { GEMINI_API_KEY: this.o.apiKey },
      timeoutMs: this.o.timeoutMs,
      task,
      workdir,
    })
  }
}
