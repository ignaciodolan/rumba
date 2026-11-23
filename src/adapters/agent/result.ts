import { constants } from 'node:fs'
import { lstat, open, rm } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { AgentError, type AgentResult, type AgentTaskKind } from '../../ports/agent.js'
import { RESULT_PATH } from './prompts.js'

// Limits keep what Rumba stores and posts within GitHub's 65,536-character bodies.
const MAX_ITEMS = 20
const MAX_CRITERION_TEXT = 500
const MAX_COMMAND = 2000
const MAX_LESSON_LINES = 3
const MAX_LESSON_LINE = 200

const criterion = z.object({ id: z.string().min(1), text: z.string().min(1).max(MAX_CRITERION_TEXT), checkable: z.boolean(), reason: z.string().max(MAX_CRITERION_TEXT).optional() })
const criteria = z.array(criterion).max(MAX_ITEMS)

/** Check files are hashed and read by Rumba later, so they must stay inside the workdir. */
const relativeFile = z.string().min(1).refine(
  (p) => !path.posix.isAbsolute(p) && !p.includes('\\') && !p.split('/').includes('..'),
  { message: 'must be a relative path inside the repository, with no ".." and no backslashes' },
)

const check = z.object({ criterionId: z.string().min(1), command: z.string().min(1).max(MAX_COMMAND), files: z.array(relativeFile) })

const schemas: Record<AgentTaskKind, z.ZodType<AgentResult>> = {
  triage: z.object({
    kind: z.literal('triage'),
    workable: z.boolean(),
    reason: z.string(),
    ticketKind: z.enum(['bug', 'feature']),
    criteria: criteria.nullable(),
    criteriaSource: z.enum(['written', 'derived']).optional(),
    notCheckable: z.array(z.object({ id: z.string().min(1), reason: z.string().trim().min(1).max(MAX_CRITERION_TEXT) })).max(MAX_ITEMS).optional(),
  }),
  'draft-criteria': z.object({ kind: z.literal('draft-criteria'), criteria }),
  'write-checks': z.object({ kind: z.literal('write-checks'), checks: z.array(check).max(MAX_ITEMS) }),
  'relocate-checks': z.object({
    kind: z.literal('relocate-checks'),
    moves: z.array(z.object({ from: relativeFile, to: relativeFile })).max(MAX_ITEMS),
    checks: z.array(check).max(MAX_ITEMS),
  }),
  revise: z.object({
    kind: z.literal('revise'),
    summary: z.string(),
    replies: z.array(z.object({ item: z.number().int().min(1), reply: z.string().trim().min(1).max(MAX_CRITERION_TEXT) })).max(MAX_ITEMS),
    noChangeNeeded: z.string().trim().min(1).max(MAX_CRITERION_TEXT * 4).optional(),
    checkChanges: z.array(z.object({
      criterionId: z.string().min(1), item: z.number().int().min(1), reason: z.string().trim().min(1).max(MAX_CRITERION_TEXT),
    })).max(MAX_ITEMS).optional(),
  }),
  'distill-lesson': z.object({
    kind: z.literal('distill-lesson'),
    lesson: z.array(z.string().trim().min(1).max(MAX_LESSON_LINE)).min(1).max(MAX_LESSON_LINES).optional(),
    none: z.string().trim().min(1).max(MAX_CRITERION_TEXT).optional(),
  }).refine((r) => (r.lesson === undefined) !== (r.none === undefined), { message: 'give exactly one of "lesson" and "none"' }),
  fix: z.object({ kind: z.literal('fix'), summary: z.string(), noChangeNeeded: z.string().trim().min(1).max(MAX_CRITERION_TEXT * 4).optional() }),
}

/** More than any real result needs; a larger file is not read. */
const MAX_RESULT_BYTES = 1_000_000

// The result file is the one thing the Rumba process itself reads from a directory the agent
// wrote to. The agent could have put a symbolic link, a named pipe or a huge file there, so
// the folder must be a real directory and the file a regular one, opened without following a
// link or blocking, and read through that one handle.

/** Removes a result left by an earlier task, without ever following a link the agent made. */
export async function clearAgentResult(workdir: string): Promise<void> {
  const dir = path.join(workdir, path.dirname(RESULT_PATH))
  const stat = await lstat(dir).catch(() => null)
  if (stat === null) return
  // rm without `recursive` removes a link or a file itself, never what a link points at.
  if (!stat.isDirectory()) await rm(dir, { force: true })
  else await rm(path.join(workdir, RESULT_PATH), { force: true, recursive: true })
}

async function readResultFile(workdir: string): Promise<string> {
  const notRegular = new AgentError(`The agent's ${RESULT_PATH} is not a regular file in a regular folder.`)
  const dir = await lstat(path.join(workdir, path.dirname(RESULT_PATH))).catch(() => null)
  if (dir === null) throw new AgentError(`The agent did not write ${RESULT_PATH}.`)
  if (!dir.isDirectory()) throw notRegular
  let handle
  try {
    handle = await open(path.join(workdir, RESULT_PATH), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') throw new AgentError(`The agent did not write ${RESULT_PATH}.`)
    throw notRegular
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw notRegular
    if (stat.size > MAX_RESULT_BYTES) throw new AgentError(`The agent's ${RESULT_PATH} is too large (${stat.size} bytes).`)
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export async function readAgentResult(workdir: string, expected: AgentTaskKind): Promise<AgentResult> {
  const raw = await readResultFile(workdir)
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AgentError(`The agent's ${RESULT_PATH} is not valid JSON.`)
  }
  const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined
  if (kind !== expected) {
    throw new AgentError(`The agent's ${RESULT_PATH} has kind ${JSON.stringify(kind) ?? 'undefined'}; expected a "${expected}" result.`)
  }
  const parsed = schemas[expected].safeParse(value)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new AgentError(`The agent's ${RESULT_PATH} has the wrong shape: ${problems}`)
  }
  return parsed.data
}
