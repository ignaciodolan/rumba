import type { Agent, AgentResult, AgentTask } from '../../ports/agent.js'
import type { Sandbox } from '../../ports/sandbox.js'
import { runCliAgent } from './cliRun.js'
import { buildPrompt } from './prompts.js'

/**
 * Claude Code, with exactly one credential: an Anthropic API key, or a long-lived token from
 * `claude setup-token`, which uses a Claude subscription. Claude Code reads the token from
 * CLAUDE_CODE_OAUTH_TOKEN, and prefers ANTHROPIC_API_KEY when both are set, so only one is given.
 */
export class ClaudeCodeAgent implements Agent {
  private readonly credential: Record<string, string>

  constructor(private readonly o: { sandbox: Sandbox; apiKey?: string; oauthToken?: string; model?: string; timeoutMs: number }) {
    if ((o.apiKey === undefined) === (o.oauthToken === undefined)) {
      throw new Error('ClaudeCodeAgent needs exactly one credential: an API key or a Claude Code token.')
    }
    this.credential = o.apiKey !== undefined ? { ANTHROPIC_API_KEY: o.apiKey } : { CLAUDE_CODE_OAUTH_TOKEN: o.oauthToken! }
  }

  async run(task: AgentTask, workdir: string): Promise<AgentResult> {
    const command = ['claude', '-p', buildPrompt(task), '--dangerously-skip-permissions']
    if (this.o.model !== undefined) command.push('--model', this.o.model)
    return runCliAgent({
      sandbox: this.o.sandbox,
      name: 'Claude Code',
      command,
      env: this.credential,
      timeoutMs: this.o.timeoutMs,
      task,
      workdir,
    })
  }
}
