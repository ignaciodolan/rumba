import type { Agent } from './agent.js'
import type { CodeHost } from './codeHost.js'
import type { Environment } from './environment.js'
import type { Tracker } from './tracker.js'
import type { Workspace } from './workspace.js'

export interface Deps {
  tracker: Tracker
  agent: Agent
  environment: Environment
  codeHost: CodeHost
  workspace: Workspace
  clock: () => Date
  runId: string
  secrets: string[]
  /** Set by the engine while it works a ticket: when the ticket's time budget runs out. */
  deadline?: Date
}
