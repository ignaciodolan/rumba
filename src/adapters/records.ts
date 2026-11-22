import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { redact } from '../core/redact.js'
import type { Agent, AgentResult, AgentTask } from '../ports/agent.js'

/** Rumba's own folder for things a person may want after a run: `RUMBA_HOME`, or `~/.cache/rumba`. */
export function rumbaHome(env: Record<string, string | undefined> = process.env): string {
  if (env.RUMBA_HOME) return env.RUMBA_HOME
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'rumba')
}

/** Where the records of one run are kept. */
export function recordsDirFor(runId: string, env: Record<string, string | undefined> = process.env): string {
  return path.join(rumbaHome(env), 'runs', runId)
}

/** A file per agent call, under one folder per run and one per ticket. Private to the user. */
export class FileRunRecords {
  constructor(readonly dir: string) {}

  async write(ticketId: string, name: string, text: string): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    await chmod(this.dir, 0o700)
    const folder = path.join(this.dir, ticketId.replace(/[^A-Za-z0-9._-]/g, '_'))
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const seq = String((await readdir(folder)).length + 1).padStart(2, '0')
    const file = path.join(folder, `${seq}-${name}.md`)
    await writeFile(file, text, { mode: 0o600 })
    return file
  }
}

/**
 * Wraps an agent so that every call leaves a record: the task, the agent's result with its
 * summary, and the last part of what it printed, or the error it ended with. Every key Rumba
 * knows is replaced with [redacted] before anything is written. A record that cannot be
 * written never fails the call.
 */
export function recordingAgent(inner: Agent, records: FileRunRecords, secrets: string[]): Agent {
  return {
    async run(task: AgentTask, workdir: string): Promise<AgentResult> {
      const name = task.attempt !== undefined ? `${task.kind}-attempt-${task.attempt}` : task.kind
      const head = [`# ${task.kind}${task.attempt !== undefined ? `, attempt ${task.attempt}` : ''} for ${task.ticket.ref}`, '', `Started: ${new Date().toISOString()}`]
      try {
        const result = await inner.run(task, workdir)
        const { transcript, ...rest } = result
        await records.write(task.ticket.id, name, redact([
          ...head, '', '## Result', '', '```json', JSON.stringify(rest, null, 2), '```',
          ...(transcript ? ['', '## End of the transcript', '', '```', transcript, '```'] : []), '',
        ].join('\n'), secrets)).catch(() => undefined)
        return result
      } catch (e) {
        await records.write(task.ticket.id, name, redact([
          ...head, '', '## Error', '', '```', e instanceof Error ? e.message : String(e), '```', '',
        ].join('\n'), secrets)).catch(() => undefined)
        throw e
      }
    },
  }
}
