import path from 'node:path'
import { protectedViolations } from './guards.js'
import type { Check, Move } from './types.js'

/**
 * Whether a relocation of Rumba's checks into the project's tests kept them as they were.
 *
 * A relocation may move a check to another file, or merge it into an existing test file. It
 * may change three things, and each only so far:
 * - imports: only how they are written. Every name a check imported must still be imported,
 *   from the same module and as the same thing, and nothing else may be imported. Imports
 *   are read only at the top of a file.
 * - test titles: the string given to describe, it or test, the name of a `test_` function or
 *   a `Test` class. The call and its modifiers stay, so `it.skip` is never `it`.
 * - where a check sits: its lines move as one block, kept together and in order, with their
 *   indentation relative to each other. A file it merged into keeps its own lines, in order,
 *   with their indentation.
 * Nothing may be added. The command must be the verified one with only the file paths
 * changed, and the check's files must be exactly its new places, which must be test files.
 *
 * This says nothing about what the code under test does. Rumba also runs every relocated
 * check, on the change and on the base commit, for that.
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
  /** Files the checks commit and the fix changed, since the base commit. */
  changedByFix?: string[]
  /**
   * Check files that were in the repository before Rumba's checks: a fixture an earlier
   * ticket's checks left, say. Other code may import them, so they stay where they are.
   */
  kept?: string[]
}

const PLAIN_PATH = /^[A-Za-z0-9._+@-]+(?:\/[A-Za-z0-9._+@-]+)*$/

/** More lines than any test file needs; a larger one is not compared. */
const MAX_LINES = 3000

/** Null when the relocation kept every check as it was; otherwise why not. */
export function judgeRelocation(i: RelocationInput): string | null {
  const kept = new Set(i.kept ?? [])
  // Only what Rumba's checks added moves; whatever was there before stays, unchanged.
  const originals = [...new Set(i.original.flatMap((c) => c.files))].filter((f) => !kept.has(f))
  const froms = i.moves.map((m) => m.from)
  const tos = [...new Set(i.moves.map((m) => m.to))]

  const ids = i.original.map((c) => c.criterionId)
  const given = i.relocated.map((c) => c.criterionId)
  const lost = ids.filter((id) => !given.includes(id))
  if (lost.length > 0) return `No relocated check was given for ${lost.map(code).join(', ')}.`
  const extra = given.filter((id, n) => !ids.includes(id) || given.indexOf(id) !== n)
  if (extra.length > 0) return `The relocation gave checks Rumba did not write, or gave one twice: ${extra.map(code).join(', ')}.`

  const staying = froms.filter((f) => kept.has(f))
  if (staying.length > 0) return `${list(staying)} was in the repository before Rumba's checks, and other code may import it, so it must stay where it is.`
  const unmoved = originals.filter((f) => !froms.includes(f))
  if (unmoved.length > 0) return `The relocation did not move ${list(unmoved)}.`
  const strangers = froms.filter((f, n) => !originals.includes(f) || froms.indexOf(f) !== n)
  if (strangers.length > 0) return `The relocation moved files that are not Rumba's checks, or moved one twice: ${list(strangers)}.`
  // One check per file: on the base commit, a file fails as a whole, so a second check in it
  // could pass for failing without ever running.
  const shared = tos.filter((t) => i.moves.filter((m) => m.to === t).length > 1)
  if (shared.length > 0) return `A file can take only one check, and ${list(shared)} was given more than one.`
  const fixed = tos.filter((t) => (i.changedByFix ?? []).includes(t))
  if (fixed.length > 0) return `A check cannot move into a file the fix changed, since that change could fail on the base commit in its place: ${list(fixed)}.`
  // Kept files included: a kept file stays as it was, so nothing may move into it either.
  const intoCheck = tos.filter((t) => originals.includes(t) || kept.has(t))
  if (intoCheck.length > 0) return `The relocation moved a check into one of Rumba's own check files: ${list(intoCheck)}.`

  // Unambiguously: no two moved files may answer to one module name, before or after, and no
  // moved file may take a module name another file already answers to (a project helper the
  // check imports, say, whose import would then reach the moved file instead).
  for (const side of ['from', 'to'] as const) {
    const names = i.moves.flatMap((m) => moduleNames(m[side]).slice(0, 1))
    const twice = names.find((n, k) => names.indexOf(n) !== k)
    if (twice !== undefined) return `Two moved files answer to the same module name, ${code(twice.slice(3))}.`
  }
  for (const m of i.moves) {
    const taken = moduleVariants(m.to).filter((v) => v !== m.to && typeof i.before[v] === 'string')
    if (taken.length > 0) return `${code(m.to)} would answer to the same module name as ${list(taken)}, which is already there.`
  }
  const touched = protectedViolations(i.changed, i.protectedGlobs)
  if (touched.length > 0) return `The relocation changed protected paths: ${list(touched)}.`
  const outside = i.changed.filter((f) => !originals.includes(f) && !tos.includes(f))
  if (outside.length > 0) return `The relocation changed files other than the checks and their new places: ${list(outside)}.`
  // A new place goes into the check's command, which runs in a shell: letters, digits and . _ - + @ only.
  const unplain = tos.filter((t) => !PLAIN_PATH.test(t) || t.split('/').some((part) => part.startsWith('-') || part === '..' || part === '.'))
  if (unplain.length > 0) return `A new place for a check must be a plain path (letters, digits, and . _ - + @ / only): ${list(unplain)}.`
  const notTests = tos.filter((t) => !isTestPath(t))
  if (notTests.length > 0) return `A check may only move into a test file, not into ${list(notTests)}.`
  const left = froms.filter((f) => typeof i.after[f] === 'string')
  if (left.length > 0) return `The relocation left the old check files in place: ${list(left)}.`
  const missing = tos.filter((t) => typeof i.after[t] !== 'string')
  if (missing.length > 0) return `The relocated files are missing, or are not regular files: ${list(missing)}.`

  for (const check of i.relocated) {
    const original = i.original.find((c) => c.criterionId === check.criterionId)!
    const mine = i.moves.filter((m) => original.files.includes(m.from))
    const places = [...new Set([...mine.map((m) => m.to), ...original.files.filter((f) => kept.has(f))])].sort()
    if (JSON.stringify([...new Set(check.files)].sort()) !== JSON.stringify(places)) {
      return `The relocated check for ${code(check.criterionId)} must list exactly its new files, ${list(places)}, not ${list(check.files)}.`
    }
    // Longest paths first, so that one path inside another is never half replaced.
    // Each path only where it stands whole, so a kept `x.test.tsx.snap` is not taken for a moved `x.test.tsx`.
    const command = [...mine].sort((a, b) => b.from.length - a.from.length)
      .reduce((c, m) => c.replace(new RegExp(`(?<![\\w.\\-/])${m.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.\\-/])`, 'g'), () => m.to), original.command)
    if (check.command !== command) {
      return `The relocated command for ${code(check.criterionId)} must be the verified one with only the file paths changed, ${code(command)}, not ${code(check.command)}.`
    }
  }

  // A check that imports another moved file (a shared fixture, say) now imports it from its new place.
  const renames = new Map(i.moves.flatMap((m) => moduleNames(m.from).map((name, n) => [name, moduleNames(m.to)[n]!] as [string, string])))
  for (const move of i.moves) {
    const original = i.original.find((c) => c.files.includes(move.from))!
    const text = i.before[move.from] ?? ''
    // A command that picks tests by title would run fewer of them once a title changed.
    const bare = original.files.reduce((c, f) => c.split(f).join(' '), original.command)
    const keepTitles = NAME_FILTER.test(bare) || titlesIn(move.from, text).some((t) => t.length > 0 && bare.includes(t))
    const reason = sameFile(move.to, i.before[move.to] ?? null, i.after[move.to]!, [{ file: move.from, text }], keepTitles, renames)
    if (reason !== null) return reason
  }
  return null
}

/** The test titles a file gives: the strings and names the title rules would replace. */
function titlesIn(file: string, text: string): string[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  // A JavaScript title's text, each piece between expressions on its own when it says something.
  return maskTitles(file, lines).titles.flatMap((pieces) => (pieces.length === 1 ? pieces : pieces.map((p) => p.trim()).filter((p) => p.length >= 3)))
}

/** A command option that picks tests by name: a renamed test could fall out of it. */
const NAME_FILTER = /(?:^|\s)(?:-t|--testNamePattern|--test-name-pattern|-k|-run|--run|--grep|-g|--filter|-m|--match|--test-name|-p|--tests|--testcase|-f|--fgrep|--grep-invert|--invert)(?:[\s=]|$)|::/

/** A top-level line that opens a test, or only closes brackets. Nothing else may sit at the top level of a file a check merges into. */
const TEST_TOP = /^(?:(?:describe|it|test|suite|context|specify)(?:\.\w+)*\s*\(|(?:async\s+)?def\s+test_|class\s+Test|func\s+(?:Test|Benchmark|Example|Fuzz)\w*\s*\(|[)}\];,\s]+$)/

/** Lines that set up or mock what every test in a file sees. */
const HOOKS = /\b(?:before(?:Each|All)|after(?:Each|All)|setUp|tearDown|setup_method|setup_function|setup_module|setup_class|teardown_\w+|autouse|usefixtures|vi\.(?:mock|doMock|spyOn|stubGlobal|stubEnv|useFakeTimers)|jest\.(?:mock|doMock|spyOn|useFakeTimers)|mock\.patch|monkeypatch|TestMain)\b/

/** Words in the name of a file that sets up or configures tests, or helps them, rather than holding them. */
const NOT_A_TEST = new Set(['config', 'setup', 'teardown', 'helper', 'conftest', 'support'])
/** Folders whose files are loaded by the test runner on its own: mocks, fixtures, and Cypress-style support files. */
const NOT_A_TEST_FOLDER = new Set(['__mocks__', '__fixtures__', 'support'])

/** A path a test runner would pick up, or a file in a test folder, and never a file that configures the tests. */
export function isTestPath(file: string): boolean {
  const name = path.posix.basename(file)
  if (name.startsWith('.') || /^(?:conftest\.py|__init__\.py|setup\.(?:py|cfg)|pytest\.ini|tox\.ini|package\.json|Makefile)$/i.test(name)) return false
  if (file.split('/').slice(0, -1).some((part) => NOT_A_TEST_FOLDER.has(part.toLowerCase()))) return false
  // A file named like a test is collected as one, whatever words its name holds
  // (`widgets-unsupported-fields.test.ts`, `api-config.test.ts`).
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name) || /^test_\w+\.py$/.test(name) || /_test\.(?:py|go)$/.test(name) || /Tests?\.(?:java|kt|cs)$/.test(name)) return true
  // Any other file is only a fixture or data in a test folder, and never one whose name holds,
  // anywhere, a word for setting up, configuring or helping tests (`vitestsetup.ts`, `HTTPSetup.ts`).
  if ([...NOT_A_TEST].some((w) => name.toLowerCase().includes(w))) return false
  return path.posix.dirname(file).split('/').some((part) => /^(?:tests?|__tests__|specs?|e2e)$/.test(part))
}

interface Line { indent: string; text: string }
interface Parsed {
  /** Each name an import binds, and what it binds it to. */
  bindings: Map<string, string>
  /** Modules imported for their side effects only. */
  effects: Set<string>
  /** Comment lines before the first line of code. */
  notes: string[]
  /** Every other line that is not blank, with its test titles replaced by a mark. */
  body: Line[]
  /** Set when one name is imported as two different things. */
  conflict?: string
}

/** Whether `after` is `before` plus the moved checks, as described above. */
function sameFile(
  to: string, before: string | null, after: string, sources: { file: string; text: string }[], keepTitles: boolean, renames: Map<string, string>,
): string | null {
  const now = parse(to, after, keepTitles)
  const was = parse(to, before ?? '', keepTitles)
  const moved = sources.map((s) => {
    const p = parse(s.file, s.text, keepTitles)
    return { file: s.file, ...p, bindings: new Map([...p.bindings].map(([name, t]) => [name, renamed(t, renames)])), effects: new Set([...p.effects].map((t) => renamed(t, renames))) }
  })
  // A file's hooks and mocks apply to every test in it, the moved check too.
  const hook = (before ?? '').split(/\r?\n/).find((l) => HOOKS.test(l))
  if (hook !== undefined) return `${code(to)} has hooks or mocks that would apply to the check, so it cannot take one: ${code(hook.trim())}.`
  // Anything else at the top level runs before the check too, so the file must hold nothing but tests.
  const stray = parse(to, before ?? '', true).body.find((l) => l.indent === '' && !TEST_TOP.test(l.text))
  if (stray !== undefined) return `${code(to)} must hold nothing but tests at its top level to take a check, and has ${code(stray.text)}.`
  if ([now, was, ...moved].some((p) => p.body.length > MAX_LINES)) return `${code(to)} is too large to compare.`
  const conflict = [now, was, ...moved].find((p) => p.conflict !== undefined)?.conflict
  if (conflict !== undefined) return `${conflict} is imported twice, as two different things.`

  // Imports: the same names, bound to the same things, and no others.
  const need = new Map(was.bindings)
  for (const m of moved) {
    for (const [name, target] of m.bindings) {
      if (need.has(name) && need.get(name) !== target) return `${code(name)} is imported as two different things by ${code(m.file)} and ${code(to)}.`
      need.set(name, target)
    }
  }
  for (const [name, target] of need) {
    if (now.bindings.get(name) !== target) return `${code(to)} must import ${code(name)} as ${code(target)}, as the verified checks did.`
  }
  for (const [name, target] of now.bindings) {
    if (!need.has(name)) return `${code(to)} imports ${code(name)} (${code(target)}), which no verified check imported.`
  }
  // A star or dot import binds names no line shows, so it could rebind one the check imports.
  if ([...now.effects].some((e) => e.endsWith('#*') || e.endsWith('#.'))) return `${code(to)} has an import that imports everything into the file (a star import), so Rumba cannot tell what its names are.`
  // Nor may the file itself bind, anywhere, a name the check imports, or import anything below its top.
  const late = was.body.find((l) => LATE_IMPORT.test(l.text))
  if (late !== undefined) return `${code(to)} imports below its top, where Rumba cannot tell what it binds: ${code(late.text)}.`
  for (const m of moved) {
    for (const name of m.bindings.keys()) {
      const line = was.body.find((l) => binds(l.text, name))
      if (line !== undefined) return `${code(to)} defines ${code(name)} itself, which the check imports: ${code(line.text)}.`
    }
  }
  const effects = new Set([...was.effects, ...moved.flatMap((m) => [...m.effects])])
  if (effects.size !== now.effects.size || [...effects].some((e) => !now.effects.has(e))) return `${code(to)} must import the same modules for their side effects as the verified checks.`

  // Lines before the code (comments, pragmas, a package clause, 'use strict') can change how
  // a file runs: every one of the file's and the check's stays, and no other is added.
  const notes = new Set(now.notes)
  const kept = new Set([...was.notes, ...moved.flatMap((m) => m.notes)])
  const dropped = [...kept].find((n) => !notes.has(n))
  if (dropped !== undefined) return `A line at the top of ${code(to)} or of the check is missing from ${code(to)}: ${code(dropped)}.`
  const strayNote = [...notes].find((n) => !kept.has(n))
  if (strayNote !== undefined) return `${code(to)} has a line at the top that is in no check Rumba verified: ${code(strayNote)}.`

  // Every line, by its text: nothing added and nothing lost.
  const texts = countOf(now.body.map((l) => l.text))
  let gone: string | null = null
  for (const source of [{ file: to, body: was.body }, ...moved]) {
    for (const line of source.body) {
      if (take(texts, line.text)) continue
      gone ??= source.file === to
        ? `A line already in ${code(to)} is missing from it after the relocation: ${code(line.text)}.`
        : `A line of ${code(source.file)} is missing from ${code(to)}: ${code(line.text)}.`
    }
  }
  // A changed line is both; the new line says more about what happened.
  const added = [...texts].find(([, c]) => c > 0)
  const titles = keepTitles ? ' The command picks tests by title, so the titles must stay as written.' : ''
  if (added) return `${code(to)} has a line that is in no check Rumba verified: ${code(added[0])}.${gone === null ? '' : ` ${gone}`}${titles}`
  if (gone !== null) return gone

  // Where the lines are: the file's own in order, each check as one block, indentation kept.
  const expected = [...was.body, ...moved.flatMap((m) => m.body)]
  if (expected.length !== now.body.length || expected.some((l, n) => l.text !== now.body[n]!.text || l.indent !== now.body[n]!.indent)) {
    return `${code(to)} keeps every line, but not in place: a check goes at the end of the file, as one block, in its order, with its indentation as written, and the lines already in the file stay as they were.${titles}`
  }

  const shadowed = shadowedTests(after, before ?? '')
  if (shadowed !== null) return `${code(to)} defines the test ${code(shadowed)} twice, so the first one would never run.`
  return null
}

/** An import anywhere in a line: an import or from statement, a require, a dynamic import. */
const LATE_IMPORT = /^(?:import|from)\s|\brequire\s*\(|\bimport\s*\(|\b__import__\b|\bimportlib\b/

/**
 * Whether a line may bind `name`, at any depth: a def, class, function or declaration of it,
 * an `as` or `global` of it, a for loop over it, or `name` anywhere before an `=` (an
 * assignment, a tuple unpacking, an annotated name). Wide on purpose: a line taken for one
 * only stops a merge.
 */
function binds(line: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$')
  const word = `(?<![\\w$])${n}(?![\\w$])`
  return new RegExp(`(?:def|class|function\\*?|const|let|var|as|global|nonlocal)\\s+${word}|\\bfor\\b[^:]*${word}[^:]*\\bin\\b|${word}.*?(?<![=!<>])=(?![=>])`).test(line)
}

/** A Python test name that appears twice at one indentation after the relocation, and did not before. */
function shadowedTests(after: string, before: string): string | null {
  const names = (text: string) => countOf(text.split(/\r?\n/).flatMap((l) => {
    const m = /^(\s*)(?:(?:async\s+)?def\s+(test_\w*)|class\s+(Test\w*)|(test_\w*)\s*(?::[^=]*)?=(?!=))/.exec(l)
    return m ? [`${m[1]}${m[2] ?? m[3] ?? m[4]}`] : []
  }))
  const was = names(before)
  for (const [name, n] of names(after)) if (n > 1 && n > (was.get(name) ?? 0)) return name.trim()
  return null
}

function countOf(items: string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of items) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

function take(m: Map<string, number>, x: string): boolean {
  const n = m.get(x) ?? 0
  if (n === 0) return false
  m.set(x, n - 1)
  return true
}

// Imports are matched by strict patterns: what a name binds to must be readable from the line
// alone, and no code can ride along on a line taken for an import. No `/` is allowed outside
// the module name, so no comment can open or close on one.
const MODULE = String.raw`(?<q>['"])([^'"\x60\\\s]+)\k<q>`
const JS_IMPORT = new RegExp(String.raw`^import\s+(?:type\s+)?([\w$\s,{}*]+?)\s+from\s*${MODULE}\s*;?$`)
const JS_EFFECT = new RegExp(String.raw`^import\s*${MODULE}\s*;?$`)
const JS_REQUIRE = new RegExp(String.raw`^(?:const|let|var)\s+([\w$]+|\{[\w$\s,:]*\})\s*=\s*require\(\s*${MODULE}\s*\)\s*;?$`)
const JS_BLOCK = { start: /^import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[\w$\s,]*$/, inside: /^[\w$\s,]*$/, end: new RegExp(String.raw`^[\w$\s,]*\}\s*from\s*${MODULE}\s*;?$`) }
const PY_IMPORT = /^import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)$/
const PY_FROM = /^from\s+(\.*[\w.]*)\s+import\s+([\w\s,*]+)$/
const PY_BLOCK = { start: /^from\s+(\.*[\w.]*)\s+import\s*\([\w\s,]*$/, inside: /^[\w\s,]*$/, end: /^[\w\s,]*\)$/ }
const GO_IMPORT = /^import\s+(?:([\w.]+)\s+)?"([^"\\\s]+)"$/
const GO_BLOCK = { start: /^import\s*\($/, inside: /^(?:[\w.]+\s+)?"[^"\\\s]+"$/, end: /^\)$/ }
const BLOCKS = [JS_BLOCK, PY_BLOCK, GO_BLOCK]
// A comment line before the code: `//` or `#`, or a block comment that opens and closes on the line.
const NOTE = /^(?:\/\/|#)|^\/\*(?:(?!\*\/).)*\*\/$|^package\s+\w+$|^(['"])use strict\1;?$/

// A test title, replaced by a mark; the call before it stays as written. JavaScript titles
// are read by `jsTitles`; these are the names of Python and Go tests.
const TITLES: [RegExp, string][] = [
  [/^((?:async\s+)?def\s+test_)\w*/, '$1<title>'],
  [/^(class\s+Test)\w*/, '$1<title>'],
  [/^(func\s+(?:Test|Benchmark|Example|Fuzz))\w*/, '$1<title>'],
]

/** A file's imports and comments up to its first line of code, and every line after that. */
function parse(file: string, text: string, keepTitles = false): Parsed {
  const out: Parsed = { bindings: new Map(), effects: new Set(), notes: [], body: [] }
  const bind = (name: string, target: string) => {
    if (out.bindings.has(name) && out.bindings.get(name) !== target) out.conflict ??= code(name)
    out.bindings.set(name, target)
  }
  const lines = text.split(/\r?\n/)
  let n = 0
  // The top of the file: blank lines, comments and imports, until the first line of code.
  for (; n < lines.length; n++) {
    const line = lines[n]!.trim()
    if (line === '') continue
    if (NOTE.test(line)) { out.notes.push(line); continue }
    if (readImport(file, line, bind, out.effects)) continue
    const end = blockEnd(lines, n)
    if (end !== null && readBlock(file, lines.slice(n, end + 1).map((l) => l.trim()), bind, out.effects)) { n = end; continue }
    break
  }
  for (; n < lines.length; n++) {
    const raw = lines[n]!
    const line = raw.trim()
    if (line === '') continue
    const indent = raw.slice(0, raw.length - raw.trimStart().length)
    out.body.push({ indent, text: line })
  }
  if (!keepTitles) {
    const masked = maskTitles(file, out.body.map((l) => l.text)).lines
    out.body = out.body.map((l, k) => ({ indent: l.indent, text: masked[k]! }))
  }
  return out
}

/** The language whose titles a file holds, by its extension; null for any other file, whose lines are compared as written. */
function languageOf(file: string): 'js' | 'jsx' | 'py' | 'go' | null {
  if (/\.[cm]?[jt]sx$/.test(file)) return 'jsx'
  if (/\.[cm]?[jt]s$/.test(file)) return 'js'
  if (file.endsWith('.py')) return 'py'
  if (file.endsWith('.go')) return 'go'
  return null
}

/**
 * Every test title in `lines` (trimmed), replaced by its mark, by the rules of the file's own
 * language, and the titles' text. In each language, once a line may leave a string open,
 * nothing more is masked: a title-like line inside a string is text, not a test.
 */
function maskTitles(file: string, lines: string[]): { lines: string[]; titles: string[][] } {
  const language = languageOf(file)
  if (language === 'js' || language === 'jsx') return jsTitles(lines, language === 'jsx')
  if (language === null) return { lines, titles: [] }
  const rules = language === 'py' ? TITLES.slice(0, 2) : TITLES.slice(2)
  const leaves = language === 'py' ? pyLeavesOpen : (line: string) => line.includes('`')
  const out = [...lines]
  const titles: string[][] = []
  for (let k = 0; k < out.length; k++) {
    for (const [p, mark] of rules) {
      const m = p.exec(out[k]!)
      if (m) { titles.push([m[0].slice(m[1]!.length)]); out[k] = out[k]!.replace(p, mark) }
    }
    if (leaves(lines[k]!)) break
  }
  return { lines: out, titles }
}

/**
 * Whether a Python line may leave a string open: it ends in a backslash, or it holds a triple
 * quote other than one docstring that opens and closes on the line.
 */
function pyLeavesOpen(line: string): boolean {
  if (line.endsWith('\\')) return true
  if (!line.includes('"""') && !line.includes("'''")) return false
  return !/^(["']{3})(?:(?!["']).)*\1$/.test(line)
}

/**
 * Whether a line ends inside a template literal, a string or a block comment. Templates are
 * followed through their `${...}` expressions, nested templates included. At a `/` outside a
 * string, which may start a regex, a division or a comment, the rest of the line cannot be
 * read safely: the line counts as open when anything after it could open a string, a template
 * or a comment, or when a template is still open.
 */
function leavesOpen(line: string): boolean {
  if (line.endsWith('\\')) return true
  // Innermost last: 't' is a template's text, 'e' one of its expressions with its brace depth.
  const stack: { kind: 't' | 'e'; depth: number }[] = []
  let n = 0
  while (n < line.length) {
    const c = line[n]!
    const top = stack.at(-1)
    if (top?.kind === 't') {
      if (c === '\\') n += 2
      else if (c === '`') { stack.pop(); n += 1 }
      else if (c === '$' && line[n + 1] === '{') { stack.push({ kind: 'e', depth: 0 }); n += 2 }
      else n += 1
      continue
    }
    if (c === "'" || c === '"') {
      let close = n + 1
      while (close < line.length && line[close] !== c) close += line[close] === '\\' ? 2 : 1
      if (close >= line.length) return true
      n = close + 1
      continue
    }
    if (c === '`') { stack.push({ kind: 't', depth: 0 }); n += 1; continue }
    if (c === '/') {
      if (line[n + 1] === '*') {
        const close = line.indexOf('*/', n + 2)
        if (close === -1) return true
        n = close + 2
        continue
      }
      return /[`'"]|\/\*/.test(line.slice(n + 1)) || stack.length > 0
    }
    if (top?.kind === 'e') {
      if (c === '{') top.depth += 1
      else if (c === '}') {
        if (top.depth === 0) stack.pop()
        else top.depth -= 1
      }
    }
    n += 1
  }
  return stack.length > 0
}

/** A call that takes a test's title as its first argument: describe, it, test and the like, with any modifiers. */
const TEST_CALL = /^((?:describe|it|test|suite|context|specify)(?:\.(?:only|skip|todo|each|concurrent|sequential|fails|shuffle))*\s*\(\s*)/

/** An expression a title may interpolate: names, members, indexes and plain calls. No regex, comment, block or template. */
const SAFE_EXPRESSION = /^[\w$.[\]\s'"?!:,()+-]*$/

/**
 * A string literal at `s[at]`: its length, the mark that stands for it, and its text. A
 * template literal's mark keeps every `${...}` expression as written and in order, so only
 * its text may change. Null when there is no literal there, when it does not close on the
 * line, or when an expression holds a template of its own (too intricate to read safely).
 */
export function readTitle(s: string, at: number): { length: number; mark: string; text: string[] } | null {
  const q = s[at]
  if (q !== "'" && q !== '"' && q !== '`') return null
  const text: string[] = ['']
  const expressions: string[] = []
  let n = at + 1
  while (n < s.length) {
    const c = s[n]!
    if (c === '\\') { text[text.length - 1] += s.slice(n, n + 2); n += 2; continue }
    if (c === q) return { length: n + 1 - at, mark: `<title${expressions.map((e) => `\${${e}}`).join('')}>`, text }
    if (q === '`' && c === '$' && s[n + 1] === '{') {
      const end = expressionEnd(s, n + 2)
      if (end === null || !SAFE_EXPRESSION.test(s.slice(n + 2, end))) return null
      expressions.push(s.slice(n + 2, end))
      text.push('')
      n = end + 1
      continue
    }
    text[text.length - 1] += c
    n += 1
  }
  return null
}

/** The index of the `}` that closes an expression starting at `from`, skipping quoted strings; null if none, or if it holds a template. */
function expressionEnd(s: string, from: number): number | null {
  let depth = 0
  for (let n = from; n < s.length; n++) {
    const c = s[n]!
    if (c === '`') return null
    if (c === "'" || c === '"') {
      const lit = readTitle(s, n)
      if (lit === null) return null
      n += lit.length - 1
      continue
    }
    if (c === '{') depth += 1
    else if (c === '}') {
      if (depth === 0) return n
      depth -= 1
    }
  }
  return null
}

/**
 * Every JavaScript test title in `lines` (trimmed), replaced by its mark, and the titles' text.
 * A title is the first argument of a test call, on the call's line or alone on the next one,
 * or, for `.each`, the first argument of the call that follows the table, on the line where
 * the table closes.
 */
function jsTitles(lines: string[], jsx = false): { lines: string[]; titles: string[][] } {
  const out = [...lines]
  const titles: string[][] = []
  // A line ending in `it(`: its title may be alone on the next line.
  let next = false
  // Inside an `.each(` table: how deep its brackets are.
  let table: number | null = null
  const mask = (k: number, at: number, requireAfter: RegExp) => {
    const t = readTitle(out[k]!, at)
    if (t === null || !requireAfter.test(out[k]!.slice(at + t.length))) return
    out[k] = out[k]!.slice(0, at) + t.mark + out[k]!.slice(at + t.length)
    titles.push(t.text)
  }
  // Once a line leaves a template, a string or a block comment open, what follows may be
  // inside it, where a test call is text and a `${...}` would run: nothing more is masked.
  let open = false
  for (let k = 0; k < out.length; k++) {
    const line = out[k]!
    if (open) continue
    // In JSX, text between tags may hold quotes that are not strings: such a line counts as open.
    open = leavesOpen(line) || (jsx && /<[A-Za-z>/]/.test(line) && /[`'"]|\/\*/.test(line))
    if (next) {
      next = false
      mask(k, 0, /^\s*,/)
      continue
    }
    if (table !== null) {
      const closed = tableEnd(line, 0, table)
      if (closed === null) { table = null; continue }
      if (typeof closed === 'number') { table = closed; continue }
      table = null
      if (closed.title === line.length) next = true
      else mask(k, closed.title, /^\s*,/)
      continue
    }
    const call = TEST_CALL.exec(line)
    if (call === null) continue
    const at = call[0].length
    if (/\.each\s*\(\s*$/.test(call[1]!)) {
      const closed = tableEnd(line, at, 1)
      if (closed === null) continue
      if (typeof closed === 'number') { table = closed; continue }
      if (closed.title === line.length) next = true
      else mask(k, closed.title, /^\s*,/)
      continue
    }
    if (at === line.length) { next = true; continue }
    mask(k, at, /^\s*[,)]/)
  }
  return { lines: out, titles }
}

/**
 * Scans an `.each(` table from `from` at bracket depth `depth`. When the table closes on this
 * line and a call follows, `{ title }` is where that call's first argument starts; when it
 * does not close, the depth to carry to the next line; null when it closes without a call
 * after it, or when a string does not close on the line.
 */
function tableEnd(line: string, from: number, depth: number): { title: number } | number | null {
  for (let n = from; n < line.length; n++) {
    const c = line[n]!
    // A comment or a regex could hold any bracket: stop reading rather than guess.
    if (c === '/') return null
    if (c === "'" || c === '"' || c === '`') {
      const lit = readTitle(line, n)
      if (lit === null) return null
      n += lit.length - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) {
        const after = /^\s*\(\s*/.exec(line.slice(n + 1))
        return after === null ? null : { title: n + 1 + after[0].length }
      }
    }
  }
  return depth
}

/** The last line of an import that starts at line `n` and spans lines, or null. */
function blockEnd(lines: string[], n: number): number | null {
  const block = BLOCKS.find((b) => b.start.test(lines[n]!.trim()))
  if (!block) return null
  for (let end = n + 1; end < lines.length; end++) {
    const line = lines[end]!.trim()
    if (block.end.test(line)) return end
    if (!block.inside.test(line)) return null
  }
  return null
}

function readBlock(file: string, lines: string[], bind: (name: string, target: string) => void, effects: Set<string>): boolean {
  if (GO_BLOCK.start.test(lines[0]!)) return lines.slice(1, -1).filter((l) => l !== '').every((l) => readImport(file, `import ${l}`, bind, effects))
  // One line again: a Python block loses its brackets.
  const joined = lines.join(' ')
  return readImport(file, PY_BLOCK.start.test(lines[0]!) ? joined.replace(/\(/, ' ').replace(/\)$/, '') : joined, bind, effects)
}

/** Reads one import statement into `bind` and `effects`. False when the line is not one Rumba can read. */
function readImport(file: string, line: string, bind: (name: string, target: string) => void, effects: Set<string>): boolean {
  let m = JS_EFFECT.exec(line)
  if (m) { effects.add(jsModule(file, m[2]!)); return true }
  m = JS_IMPORT.exec(line)
  if (m) {
    const mod = jsModule(file, m[3]!)
    const spec = /^(?:([\w$]+)\s*(?:,\s*|$))?(?:\{([\w$\s,]*)\}|\*\s+as\s+([\w$]+))?$/.exec(m[1]!.trim())
    if (!spec || (!spec[1] && spec[2] === undefined && !spec[3])) return false
    const named: [string, string][] = []
    for (const part of (spec[2] ?? '').split(',').map((p) => p.trim().replace(/^type\s+/, '')).filter((p) => p !== '')) {
      const one = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(part)
      if (!one) return false
      named.push([one[2] ?? one[1]!, `${mod}#${one[1]}`])
    }
    if (spec[1]) bind(spec[1], `${mod}#default`)
    if (spec[3]) bind(spec[3], `${mod}#*`)
    for (const [name, target] of named) bind(name, target)
    return true
  }
  m = JS_REQUIRE.exec(line)
  if (m) {
    const mod = jsModule(file, m[3]!)
    const target = m[1]!
    if (!target.startsWith('{')) { bind(target, `${mod}#require`); return true }
    const named: [string, string][] = []
    for (const part of target.slice(1, -1).split(',').map((p) => p.trim()).filter((p) => p !== '')) {
      const one = /^([\w$]+)(?:\s*:\s*([\w$]+))?$/.exec(part)
      if (!one) return false
      named.push([one[2] ?? one[1]!, `${mod}#${one[1]}`])
    }
    for (const [name, t] of named) bind(name, t)
    return true
  }
  m = PY_IMPORT.exec(line)
  if (m) {
    for (const part of m[1]!.split(',').map((p) => p.trim())) {
      const [name, alias] = part.split(/\s+as\s+/)
      if (alias) bind(alias, `py:${name}#*`)
      else { bind(name!.split('.')[0]!, `py:${name!.split('.')[0]}#*`); effects.add(`py:${name}`) }
    }
    return true
  }
  m = PY_FROM.exec(line)
  if (m) {
    const mod = pyModule(file, m[1]!)
    const named: [string, string][] = []
    const parts = m[2]!.split(',').map((p) => p.trim()).filter((p) => p !== '')
    for (const part of parts) {
      const one = /^(\w+|\*)(?:\s+as\s+(\w+))?$/.exec(part)
      if (!one) return false
      named.push([one[1] === '*' ? '' : (one[2] ?? one[1]!), `${mod}#${one[1]}`])
    }
    for (const [name, target] of named) if (name === '') effects.add(target); else bind(name, target)
    return true
  }
  m = GO_IMPORT.exec(line)
  if (m) {
    const name = m[1] ?? m[2]!.split('/').at(-1)!
    if (name === '_' || name === '.') effects.add(`go:${m[2]}#${name}`)
    else bind(name, `go:${m[2]}`)
    return true
  }
  return false
}

/** A relative module, as the repository path it names; any other module as written. */
function jsModule(file: string, spec: string): string {
  return spec.startsWith('./') || spec.startsWith('../') ? `js:${withoutExtension(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))}` : `js:${spec}`
}

/**
 * A relative module without the extension TypeScript maps between source and import: `./x.js`
 * names `x.ts` or `x.tsx` too, `.mjs` names `.mts`, `.cjs` names `.cts`. Families stay apart.
 */
function withoutExtension(p: string): string {
  return p.replace(/\.(?:jsx?|tsx?)$/, '').replace(/\.m[jt]s$/, '.mjs').replace(/\.c[jt]s$/, '.cjs')
}

/** The module names a repository file is imported by: as a JavaScript module, and as a Python one by path and, when no folder has a dot, dotted. */
function moduleNames(file: string): string[] {
  const bare = file.replace(/\.py$/, '')
  const dotted = bare.includes('.') ? `py:\0${bare}` : `py:${bare.replace(/\//g, '.')}`
  return [`js:${withoutExtension(file)}`, `py:${bare}`, dotted]
}

/** Every path that answers to the same module name as `file`, `file` included. Exported for the step, which reads them all. */
export function moduleVariants(file: string): string[] {
  const dir = path.posix.dirname(file)
  const stem = path.posix.basename(file).replace(/\.d\.ts$|\.[^.]+$/, '')
  const at = (p: string) => (dir === '.' ? p : `${dir}/${p}`)
  // What Node, TypeScript, Vite and Python try for a module name: the file with each
  // extension, and the folder of that name with an index, a package.json or an __init__.py.
  const exts = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.mjs', '.cts', '.cjs', '.json', '.node', '.py']
  const inFolder = [...['ts', 'tsx', 'd.ts', 'js', 'jsx', 'mts', 'mjs', 'cts', 'cjs', 'json'].map((e) => `index.${e}`), 'package.json', '__init__.py']
  const out = [...exts.map((e) => at(`${stem}${e}`)), ...inFolder.map((f) => at(`${stem}/${f}`))]
  // `x/index.ts` and `x.ts` both answer to `x`.
  if (stem === 'index' || stem === '__init__') out.push(...exts.map((e) => `${dir}${e}`))
  return [...new Set(out)]
}

/** A binding's target with its module replaced by the module's new place, when it moved. */
function renamed(target: string, renames: Map<string, string>): string {
  const hash = target.indexOf('#')
  const mod = hash < 0 ? target : target.slice(0, hash)
  const to = renames.get(mod)
  return to === undefined ? target : `${to}${hash < 0 ? '' : target.slice(hash)}`
}

function pyModule(file: string, spec: string): string {
  const dots = /^\.*/.exec(spec)![0].length
  if (dots === 0) return `py:${spec}`
  let dir = path.posix.dirname(file)
  for (let n = 1; n < dots; n++) dir = path.posix.dirname(dir)
  return `py:${path.posix.join(dir, spec.slice(dots).replace(/\./g, '/'))}`
}

function code(text: string): string {
  const flat = text.length > 200 ? `${text.slice(0, 200)}…` : text
  const ticks = '`'.repeat(Math.max(0, ...[...flat.matchAll(/`+/g)].map((m) => m[0].length)) + 1)
  return ticks.length > 1 ? `${ticks} ${flat} ${ticks}` : `${ticks}${flat}${ticks}`
}

function list(files: string[]): string {
  return files.map(code).join(', ')
}
