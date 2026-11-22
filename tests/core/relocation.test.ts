import { describe, expect, it } from 'vitest'
import { judgeRelocation, type RelocationInput } from '../../src/core/relocation.js'

// The check Rumba wrote and verified, in its own file.
const ORIGINAL = [
  "import { describe, expect, it } from 'vitest'",
  "import { saveProfile } from '../../src/profile'",
  '',
  "describe('c1', () => {",
  "  it('c1: saving a profile returns 200', async () => {",
  "    const res = await saveProfile({ name: 'Ada' })",
  '    expect(res.status).toBe(200)',
  "    expect(res.body.name).toBe('Ada')",
  '  })',
  '})',
  '',
].join('\n')

// An existing test file of the project, where the check naturally belongs.
const EXISTING = [
  "import { describe, expect, it } from 'vitest'",
  "import { loadProfile } from '../src/profile'",
  '',
  "describe('profile', () => {",
  "  it('loads a profile', async () => {",
  '    expect((await loadProfile(1)).status).toBe(200)',
  '  })',
  '})',
  '',
].join('\n')

// The check merged into it: new imports, a descriptive title, the body as it was.
const MERGED = [
  "import { describe, expect, it } from 'vitest'",
  "import { loadProfile, saveProfile } from '../src/profile'",
  '',
  "describe('profile', () => {",
  "  it('loads a profile', async () => {",
  '    expect((await loadProfile(1)).status).toBe(200)',
  '  })',
  '})',
  '',
  "describe('saving a profile', () => {",
  '  it("returns 200 and the saved name", async () => {',
  "    const res = await saveProfile({ name: 'Ada' })",
  '    expect(res.status).toBe(200)',
  "    expect(res.body.name).toBe('Ada')",
  '  })',
  '})',
  '',
].join('\n')

const FROM = 'tests/rumba/c1.test.ts'
const TO = 'test/profile.test.ts'

function input(overrides: Partial<RelocationInput> = {}, after: Record<string, string | null> = {}): RelocationInput {
  return {
    original: [{ criterionId: 'c1', command: `npx vitest run ${FROM}`, files: [FROM] }],
    moves: [{ from: FROM, to: TO }],
    relocated: [{ criterionId: 'c1', command: `npx vitest run ${TO}`, files: [TO] }],
    changed: [FROM, TO],
    before: { [FROM]: ORIGINAL, [TO]: EXISTING },
    after: { [FROM]: null, [TO]: MERGED, ...after },
    protectedGlobs: [],
    ...overrides,
  }
}

/** MERGED with one line of the check replaced. */
function mergedWith(line: string, replacement: string | string[]): string {
  const lines = MERGED.split('\n')
  const i = lines.lastIndexOf(line)
  if (i < 0) throw new Error(`no line ${line}`)
  lines.splice(i, 1, ...([] as string[]).concat(replacement))
  return lines.join('\n')
}

describe('judgeRelocation', () => {
  it('accepts a check merged into an existing test file with new imports, a new title and new indentation', () => {
    expect(judgeRelocation(input())).toBeNull()
  })

  it('accepts a check moved to a new file of its own', () => {
    const moved = ORIGINAL.replace("'../../src/profile'", "'../src/profile'").replace("'c1: saving a profile returns 200'", "'returns 200'")
    expect(judgeRelocation(input({ changed: [FROM, 'test/save.test.ts'], moves: [{ from: FROM, to: 'test/save.test.ts' }], relocated: [{ criterionId: 'c1', command: 'npx vitest run test/save.test.ts', files: ['test/save.test.ts'] }] }, { [TO]: EXISTING, 'test/save.test.ts': moved }))).toBeNull()
  })

  describe('rejects a relocation that weakens a check', () => {
    it('changes an assertion', () => {
      const r = judgeRelocation(input({}, { [TO]: mergedWith('    expect(res.status).toBe(200)', '    expect(res.status).toBeLessThan(600)') }))
      expect(r).toMatch(/expect\(res\.status\)\.toBeLessThan\(600\)/)
    })
    it('drops an assertion', () => {
      const r = judgeRelocation(input({}, { [TO]: mergedWith("    expect(res.body.name).toBe('Ada')", []) }))
      expect(r).toMatch(/missing/i)
      expect(r).toContain("expect(res.body.name).toBe('Ada')")
    })
    it('skips the test', () => {
      const r = judgeRelocation(input({}, { [TO]: mergedWith('  it("returns 200 and the saved name", async () => {', '  it.skip("returns 200 and the saved name", async () => {') }))
      expect(r).not.toBeNull()
    })
    it('adds a line, such as an early return', () => {
      const r = judgeRelocation(input({}, { [TO]: mergedWith("    const res = await saveProfile({ name: 'Ada' })", ["    const res = await saveProfile({ name: 'Ada' })", '    return']) }))
      expect(r).toMatch(/return/)
    })
    it('adds a mock between the imports', () => {
      const lines = MERGED.split('\n'); lines.splice(2, 0, "vi.mock('../src/profile')")
      expect(judgeRelocation(input({}, { [TO]: lines.join('\n') }))).toMatch(/vi\.mock/)
    })
    it('hides code behind an import line', () => {
      const lines = MERGED.split('\n'); lines[1] = "import { loadProfile, saveProfile } from '../src/profile'; process.exit(0)"
      expect(judgeRelocation(input({}, { [TO]: lines.join('\n') }))).not.toBeNull()
    })
    it('reorders the lines of the check', () => {
      const r = judgeRelocation(input({}, { [TO]: MERGED.replace("    expect(res.status).toBe(200)\n    expect(res.body.name).toBe('Ada')", "    expect(res.body.name).toBe('Ada')\n    expect(res.status).toBe(200)") }))
      expect(r).toMatch(/order/i)
    })
    it('changes a string that is not a test title', () => {
      const r = judgeRelocation(input({}, { [TO]: MERGED.replace("saveProfile({ name: 'Ada' })", "saveProfile({ name: 'Bob' })") }))
      expect(r).not.toBeNull()
    })
    it('removes a test that was already in the file it merged into', () => {
      const r = judgeRelocation(input({}, { [TO]: MERGED.replace('    expect((await loadProfile(1)).status).toBe(200)\n', '') }))
      expect(r).toMatch(/loadProfile\(1\)/)
    })
    it('changes a file that is not a check', () => {
      const r = judgeRelocation(input({ changed: [FROM, TO, 'vitest.config.ts'] }, { 'vitest.config.ts': 'export default {}' }))
      expect(r).toMatch(/vitest\.config\.ts/)
    })
    it('changes a protected file', () => {
      const r = judgeRelocation(input({ changed: [FROM, TO, '.github/workflows/ci.yml'], moves: [{ from: FROM, to: TO }] }))
      expect(r).toMatch(/\.github\/workflows\/ci\.yml/)
    })
    it('leaves the original check in place', () => {
      const r = judgeRelocation(input({}, { [FROM]: ORIGINAL }))
      expect(r).toMatch(/tests\/rumba\/c1\.test\.ts/)
    })
    it('does not move every check file', () => {
      const r = judgeRelocation(input({ original: [{ criterionId: 'c1', command: `npx vitest run ${FROM}`, files: [FROM, 'tests/rumba/fixture.json'] }] }))
      expect(r).toMatch(/tests\/rumba\/fixture\.json/)
    })
    it('drops a criterion, or adds one', () => {
      expect(judgeRelocation(input({ relocated: [] }))).toMatch(/c1/)
      expect(judgeRelocation(input({ relocated: [{ criterionId: 'c1', command: `npx vitest run ${TO}`, files: [TO] }, { criterionId: 'c9', command: 'true', files: [TO] }] }))).toMatch(/c9/)
    })
    it('gives a command that still runs the old file, or no longer names the new one', () => {
      expect(judgeRelocation(input({ relocated: [{ criterionId: 'c1', command: `npx vitest run ${FROM}`, files: [TO] }] }))).toMatch(/tests\/rumba\/c1\.test\.ts/)
      expect(judgeRelocation(input({ relocated: [{ criterionId: 'c1', command: 'npx vitest run test/other.test.ts', files: [TO] }] }))).toMatch(/test\/profile\.test\.ts/)
    })
    it('names a relocated file that does not exist or is not regular', () => {
      expect(judgeRelocation(input({}, { [TO]: null }))).toMatch(/test\/profile\.test\.ts/)
    })
  })

  it('accepts a Python test renamed by its function name, and rejects one renamed out of the test runner', () => {
    // Python: the test function's name is its title, and it may change; the body may not.
    const original = 'from app.slug import slugify\n\ndef test_c1():\n    assert slugify("Hello World") == "hello-world"\n'
    const existing = 'from app.slug import slugify\n\ndef test_joins_words():\n    assert slugify("a b") == "a-b"\n'
    const merged = `${existing}\n\ndef test_lower_cases_the_slug():\n    assert slugify("Hello World") == "hello-world"\n`
    const files = { before: { 'tests/rumba/test_c1.py': original, 'tests/test_slug.py': existing }, after: { 'tests/rumba/test_c1.py': null, 'tests/test_slug.py': merged } }
    const base = {
      original: [{ criterionId: 'c1', command: 'pytest tests/rumba/test_c1.py', files: ['tests/rumba/test_c1.py'] }],
      moves: [{ from: 'tests/rumba/test_c1.py', to: 'tests/test_slug.py' }],
      relocated: [{ criterionId: 'c1', command: 'pytest tests/test_slug.py', files: ['tests/test_slug.py'] }],
      changed: ['tests/rumba/test_c1.py', 'tests/test_slug.py'], protectedGlobs: [], ...files,
    }
    expect(judgeRelocation(base)).toBeNull()
    // Renaming the function so the test runner no longer collects it disables the check.
    expect(judgeRelocation({ ...base, after: { ...files.after, 'tests/test_slug.py': merged.replace('def test_lower_cases_the_slug', 'def lower_cases_the_slug') } })).not.toBeNull()
  })
})
