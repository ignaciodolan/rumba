import { protectedViolations } from './guards.js'
import type { Check, Move } from './types.js'

/**
 * Whether a relocation of Rumba's checks into the project's tests kept them as they were.
 *
 * A relocation may move a check to another file, merge it into an existing test file, change
 * its imports, its test titles and its indentation. Nothing else: every other line of each
 * check must be in its new file, in the same order, and the new files may hold no line that
 * was not in a check or already there. The lines already in a file a check merged into stay,
 * in their order. This is a line check: it says nothing about what the imports now point at
 * or what the commands run. Rumba runs the relocated checks on the change and on the base
 * commit for that.
 */
export interface RelocationInput {
  /** The checks Rumba wrote and verified. */
  original: Check[]
  moves: Move[]
  /** The checks as they run from their new place. */
  relocated: Check[]
  /** Every file the relocation commit changed. */
  changed: string[]
  /** File texts at the verified change, and after the relocation; null where there is no regular file. */
  before: Record<string, string | null>
  after: Record<string, string | null>
  protectedGlobs: string[]
}

/** More lines than any test file needs; a larger one is not compared. */
const MAX_LINES = 5000

/** Null when the relocation kept every check as it was; otherwise why not, in one sentence. */
export function judgeRelocation(i: RelocationInput): string | null {
  const originals = [...new Set(i.original.flatMap((c) => c.files))]
  const froms = i.moves.map((m) => m.from)
  const tos = [...new Set(i.moves.map((m) => m.to))]

  const ids = i.original.map((c) => c.criterionId)
  const given = i.relocated.map((c) => c.criterionId)
  const lost = ids.filter((id) => !given.includes(id))
  if (lost.length > 0) return `No relocated check was given for ${lost.join(', ')}.`
  const extra = given.filter((id, n) => !ids.includes(id) || given.indexOf(id) !== n)
  if (extra.length > 0) return `The relocation gave checks Rumba did not write, or gave one twice: ${extra.join(', ')}.`

  const unmoved = originals.filter((f) => !froms.includes(f))
  if (unmoved.length > 0) return `The relocation did not move ${list(unmoved)}.`
  const strangers = froms.filter((f, n) => !originals.includes(f) || froms.indexOf(f) !== n)
  if (strangers.length > 0) return `The relocation moved files that are not Rumba's checks, or moved one twice: ${list(strangers)}.`
  const intoCheck = tos.filter((t) => originals.includes(t))
  if (intoCheck.length > 0) return `The relocation moved a check into one of Rumba's own check files: ${list(intoCheck)}.`

  const touched = protectedViolations(i.changed, i.protectedGlobs)
  if (touched.length > 0) return `The relocation changed protected paths: ${list(touched)}.`
  const outside = i.changed.filter((f) => !originals.includes(f) && !tos.includes(f))
  if (outside.length > 0) return `The relocation changed files other than the checks and their new places: ${list(outside)}.`
  const left = froms.filter((f) => i.after[f] !== null && i.after[f] !== undefined)
  if (left.length > 0) return `The relocation left the old check files in place: ${list(left)}.`
  const missing = tos.filter((t) => typeof i.after[t] !== 'string')
  if (missing.length > 0) return `The relocated files are missing, or are not regular files: ${list(missing)}.`

  for (const check of i.relocated) {
    const original = i.original.find((c) => c.criterionId === check.criterionId)!
    if (check.files.length === 0) return `The relocated check for ${check.criterionId} lists no files.`
    const absent = check.files.filter((f) => typeof i.after[f] !== 'string')
    if (absent.length > 0) return `The relocated check for ${check.criterionId} needs files that do not exist: ${list(absent)}.`
    const stale = froms.filter((f) => check.files.includes(f) || check.command.includes(f))
    if (stale.length > 0) return `The relocated check for ${check.criterionId} still uses the old check file ${list(stale)}.`
    const mine = i.moves.filter((m) => original.files.includes(m.from)).map((m) => m.to)
    if (original.files.some((f) => original.command.includes(f)) && !mine.some((t) => check.command.includes(t))) {
      return `The relocated command for ${check.criterionId} does not name its new test file ${list(mine)}.`
    }
  }

  for (const to of tos) {
    const reason = sameLines(to, i.before[to] ?? '', i.after[to]!, i.moves.filter((m) => m.to === to).map((m) => ({ file: m.from, text: i.before[m.from] ?? '' })))
    if (reason !== null) return reason
  }
  return null
}

/** Whether `after` is `before` plus the lines of `checks`, each kept in order, with nothing else. */
function sameLines(to: string, before: string, after: string, checks: { file: string; text: string }[]): string | null {
  const now = significant(after)
  const was = significant(before)
  const moved = checks.map((c) => ({ file: c.file, lines: significant(c.text) }))
  if ([now, was, ...moved.map((m) => m.lines)].some((l) => l.length > MAX_LINES)) return `${code(to)} is too large to compare.`

  const count = new Map<string, number>()
  for (const line of now) count.set(line, (count.get(line) ?? 0) + 1)
  let lost: string | null = null
  for (const source of [{ file: to, lines: was }, ...moved]) {
    for (const line of source.lines) {
      const n = count.get(line) ?? 0
      if (n === 0) {
        lost ??= source.file === to
          ? `A line already in ${code(to)} is missing from it after the relocation: ${code(line)}.`
          : `A line of ${code(source.file)} is missing from ${code(to)}: ${code(line)}.`
      } else {
        count.set(line, n - 1)
      }
    }
  }
  // A changed line is both: the new line says more about what happened.
  const added = [...count].find(([, n]) => n > 0)
  if (added) return `${code(to)} has a line that is in no check Rumba verified: ${code(added[0])}.${lost === null ? '' : ` ${lost}`}`
  if (lost !== null) return lost

  for (const source of [{ file: to, lines: was }, ...moved]) {
    if (!inOrder(source.lines, now)) return `The lines of ${code(source.file)} are not in their order in ${code(to)}.`
  }
  return null
}

/** Whether `part` is a subsequence of `whole`. */
function inOrder(part: string[], whole: string[]): boolean {
  let at = 0
  for (const line of whole) if (at < part.length && line === part[at]) at += 1
  return at === part.length
}

// What may change in a relocation: whole import statements, a test's title, indentation. The
// patterns are strict, so that no code can ride along on a line taken for an import.
const QUOTED = String.raw`(['"])[^'"\x60\\]+\1`
const IMPORT_LINES = [
  // JavaScript and TypeScript
  new RegExp(String.raw`^import\s[^;'"\x60()=]*\sfrom\s*${QUOTED}\s*;?$`),
  new RegExp(String.raw`^import\s*${QUOTED}\s*;?$`),
  new RegExp(String.raw`^export\s[^;'"\x60()=]*\sfrom\s*${QUOTED}\s*;?$`),
  new RegExp(String.raw`^(?:const|let|var)\s+(?:[\w$]+|\{[\w$\s,:]*\})\s*=\s*require\(\s*${QUOTED}\s*\)\s*;?$`),
  // Python
  /^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*$/,
  /^from\s+[\w.]+\s+import\s+[\w\s,*]+$/,
  // Go
  /^import\s+(?:[\w.]+\s+)?"[^"\\]+"$/,
]
/** The first line of an import that spans lines, the lines inside it, and its last line. */
const IMPORT_BLOCKS: { start: RegExp; inside: RegExp; end: RegExp }[] = [
  { start: /^(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[\w$\s,]*$/, inside: /^[\w$\s,]*$/, end: new RegExp(String.raw`^[\w$\s,]*\}\s*from\s*${QUOTED}\s*;?$`) },
  { start: /^from\s+[\w.]+\s+import\s*\([\w\s,]*$/, inside: /^[\w\s,]*$/, end: /^[\w\s,]*\)$/ },
  { start: /^import\s*\($/, inside: /^(?:[\w.]+\s+)?"[^"\\]+"$/, end: /^\)$/ },
]
// A test title: the first argument of describe, it, test and the like, when it is a string,
// and the name of a Python or Go test function or class. The call and its modifiers stay, so
// `it.skip` is never taken for `it`, and a test cannot be renamed out of its runner.
const TITLES: [RegExp, string][] = [
  [/^((?:describe|it|test|suite|context|specify)(?:\.\w+)*\s*\(\s*)(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\$]|\\.)*`)/, '$1<title>'],
  [/^((?:async\s+)?def\s+test_)\w*/, '$1<title>'],
  [/^(class\s+Test)\w*/, '$1<title>'],
  [/^(func\s+(?:Test|Benchmark|Example|Fuzz))\w*/, '$1<title>'],
]

/** The lines that matter, trimmed: no blank line, no import, and every test title replaced by a mark. */
function significant(text: string): string[] {
  const out: string[] = []
  const keep = (line: string) => { if (line !== '') out.push(TITLES.reduce((l, [p, mark]) => l.replace(p, mark), line)) }
  let block: { rule: (typeof IMPORT_BLOCKS)[number]; lines: string[] } | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (block !== null) {
      if (block.rule.end.test(line)) { block = null; continue }
      if (block.rule.inside.test(line)) { block.lines.push(line); continue }
      // Not an import after all: the lines taken for its start count again.
      block.lines.forEach(keep)
      block = null
    }
    if (line === '' || IMPORT_LINES.some((p) => p.test(line))) continue
    const rule: (typeof IMPORT_BLOCKS)[number] | undefined = IMPORT_BLOCKS.find((b) => b.start.test(line))
    if (rule) { block = { rule, lines: [line] }; continue }
    keep(line)
  }
  block?.lines.forEach(keep)
  return out
}

function code(text: string): string {
  return `\`${text.length > 200 ? `${text.slice(0, 200)}…` : text}\``
}

function list(files: string[]): string {
  return files.map(code).join(', ')
}
