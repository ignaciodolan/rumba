import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { defaultLabels, isValidRumbaName } from '../core/labels.js'
import type { LabelNames } from '../core/types.js'
import { mergeLabels, rumbaFileSchema } from './schema.js'

export class ConfigError extends Error {}

export interface RumbaConfig {
  name: string
  dir: string
  paths: string[]
  tracker: { kind: 'github' | 'linear'; team?: string; project?: string }
  agent: { kind: 'claude-code' | 'gemini-cli'; model?: string }
  environment:
    | { kind: 'docker'; up: string; exec: string; down: string; protected: string[]; commandTimeoutMinutes: number; minFreeDiskGb: number }
    | { kind: 'vercel-preview'; projectId?: string; protected: string[] }
  verify: { test?: string }
  /** relocate: move Rumba's checks into the project's own tests once the change is verified. */
  checks: { relocate: boolean }
  /** The container the agent and the URL checks run in: the Node major version of Rumba's sandbox image. */
  sandbox: { nodeVersion: string }
  /** Who Rumba's commits are made as, when rumba.yml says; see resolveCommitAuthor. */
  commitAuthor?: { name: string; email: string }
  limits: { maxTicketsPerRun: number; minutesPerTicket: number; maxFixAttempts: number }
  labels: LabelNames
  context: string
}

const NO_RUMBAS = 'No rumbas found. Create one with `rumba init`.'

async function readOptional(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
}

async function rumbaNames(repoRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(path.join(repoRoot, '.rumba'), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

async function readContext(dir: string): Promise<string> {
  const parts: string[] = []
  for (const file of ['context.md', 'lessons.md']) {
    const text = (await readOptional(path.join(dir, file)))?.trim()
    if (text) parts.push(text)
  }
  return parts.join('\n\n')
}

async function loadOne(repoRoot: string, name: string): Promise<RumbaConfig> {
  if (!isValidRumbaName(name)) {
    throw new ConfigError(`${name}: a rumba name may only use lowercase letters, digits and hyphens (for example "my-app")`)
  }
  const dir = path.join(repoRoot, '.rumba', name)
  const text = await readOptional(path.join(dir, 'rumba.yml'))
  if (text === undefined) throw new ConfigError(`${name}: missing rumba.yml in .rumba/${name}`)

  let raw: unknown
  try {
    raw = parse(text)
  } catch (e) {
    throw new ConfigError(`${name}: rumba.yml is not valid YAML: ${(e as Error).message}`)
  }
  const parsed = rumbaFileSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new ConfigError(`${name}: ${problems.join('; ')}`)
  }
  const c = parsed.data
  const env = c.environment
  return {
    name,
    dir,
    paths: c.paths,
    tracker: c.tracker,
    agent: c.agent,
    environment:
      env.kind === 'docker'
        ? { kind: 'docker', up: env.up, exec: env.exec, down: env.down, protected: env.protected, commandTimeoutMinutes: env.command_timeout_minutes, minFreeDiskGb: env.min_free_disk_gb }
        : { kind: 'vercel-preview', ...(env.project_id ? { projectId: env.project_id } : {}), protected: env.protected },
    verify: c.verify,
    checks: { relocate: c.checks.relocate },
    sandbox: { nodeVersion: c.sandbox.node },
    ...(c.commit_author ? { commitAuthor: c.commit_author } : {}),
    limits: {
      maxTicketsPerRun: c.limits.max_tickets_per_run,
      minutesPerTicket: c.limits.minutes_per_ticket,
      maxFixAttempts: c.limits.max_fix_attempts,
    },
    labels: mergeLabels(defaultLabels(name), c.labels),
    context: await readContext(dir),
  }
}

export async function loadRumbas(repoRoot: string): Promise<RumbaConfig[]> {
  const names = await rumbaNames(repoRoot)
  if (names.length === 0) throw new ConfigError(NO_RUMBAS)
  return Promise.all(names.map((n) => loadOne(repoRoot, n)))
}

export async function loadRumba(repoRoot: string, name: string): Promise<RumbaConfig> {
  const names = await rumbaNames(repoRoot)
  if (!names.includes(name)) {
    const have = names.length > 0 ? names.join(', ') : 'none'
    throw new ConfigError(`No rumba named "${name}". Rumbas in this repository: ${have}`)
  }
  return loadOne(repoRoot, name)
}
