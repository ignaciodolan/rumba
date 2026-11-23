// Test titles a relocation may rename. A live run moved a check whose title was a template
// literal (`c7: ${action} ...`), with a command that selects by file only, and Rumba refused
// the new title: the title rule knew template literals only without `${...}`. A title may
// change its literal text in any form below; its expressions, its call and the rest of the
// line may not.
import { describe, expect, it } from 'vitest'
import { judgeRelocation } from '../../src/core/relocation.js'

const FROM = 'tests/rumba/c1.test.ts'
const TO = 'tests/orders/fulfilment.test.ts'
const HEAD = "import { describe, expect, it, test } from 'vitest'\nimport { fulfil } from '@/lib/orders'\n\n"

/** Judges a move of a check file whose body is `before` to a new file whose body is `after`. */
function judge(before: string, after: string, command = `npx vitest run ${FROM}`): string | null {
  return judgeRelocation({
    original: [{ criterionId: 'c1', command, files: [FROM] }],
    moves: [{ from: FROM, to: TO }],
    relocated: [{ criterionId: 'c1', command: command.split(FROM).join(TO), files: [TO] }],
    changed: [FROM, TO],
    before: { [FROM]: HEAD + before, [TO]: null },
    after: { [FROM]: null, [TO]: HEAD + after },
    protectedGlobs: [],
  })
}

const body = (title: string, call = 'test') => [
  "for (const action of ['ship', 'pickup']) {",
  `  ${call}(${title}, async () => {`,
  '    const order = await fulfil(action)',
  '    expect(order.fulfilledOn).toBeDefined()',
  '  })',
  '}',
  '',
].join('\n')

describe('a template literal title', () => {
  it('may change its text while its expressions stay as they were', () => {
    expect(judge(body('`c1: ${action} sets fulfilledOn once`'), body('`${action} sets fulfilledOn only when it is empty`'))).toBeNull()
    expect(judge(body('`c1 ${action} for ${"a"} order`'), body('`order ${action} with ${"a"}`'))).toBeNull()
  })

  it('may not change, drop, add or reorder an expression', () => {
    const was = body('`c1: ${action} sets fulfilledOn once`')
    expect(judge(was, body('`${other} sets fulfilledOn once`'))).not.toBeNull()
    expect(judge(was, body('`${action.toUpperCase()} sets fulfilledOn once`'))).not.toBeNull()
    expect(judge(was, body('`sets fulfilledOn once`'))).not.toBeNull()
    expect(judge(was, body('`${action} ${action} sets fulfilledOn once`'))).not.toBeNull()
    expect(judge(body('`${a} and ${b}`'), body('`${b} and ${a}`'))).not.toBeNull()
  })

  it('may not change the rest of the line', () => {
    const was = body('`c1: ${action} sets fulfilledOn once`')
    expect(judge(was, body('`${action} sets fulfilledOn once`', 'test.skip'))).not.toBeNull()
    expect(judge(was, body('`${action} sets fulfilledOn once`').replace('async () => {', 'async () => { return'))).not.toBeNull()
  })

  it('is compared as written when an expression holds a template of its own', () => {
    // Too intricate to read safely: the title stays exactly as it was.
    const was = body('`c1: ${`${action}`} sets fulfilledOn`')
    expect(judge(was, body('`${`${action}`} sets fulfilledOn`'))).not.toBeNull()
    expect(judge(was, was)).toBeNull()
  })

  it('stays exact when the command selects tests by name', () => {
    expect(judge(body('`c1: ${action} sets fulfilledOn`'), body('`${action} sets fulfilledOn`'), `npx vitest run ${FROM} -t c1`)).toMatch(/title/)
  })
})

describe('other title forms', () => {
  it('renames it, describe and test titles in single, double or backtick quotes, and from one quote to another', () => {
    const simple = (call: string, title: string) => `${call}(${title}, () => {\n  expect(fulfil('ship')).toBeDefined()\n})\n`
    for (const call of ['it', 'test', 'describe', 'it.only', 'describe.concurrent']) {
      expect(judge(simple(call, "'c1: ships'"), simple(call, '"ships an order"')), call).toBeNull()
      expect(judge(simple(call, '"c1: ships"'), simple(call, '`ships an order`')), call).toBeNull()
      expect(judge(simple(call, '`c1: ships`'), simple(call, "'ships an order'")), call).toBeNull()
    }
  })

  it('renames the title of test.each and describe.each, with the table on the same line', () => {
    const each = (call: string, table: string, title: string) => `${call}(${table})(${title}, (n) => {\n  expect(fulfil(n)).toBeDefined()\n})\n`
    for (const call of ['test.each', 'it.each', 'describe.each']) {
      expect(judge(each(call, '[1, 2]', "'c1: ships %i'"), each(call, '[1, 2]', "'ships order %i'")), call).toBeNull()
      // The table is data the test runs on: it must stay.
      expect(judge(each(call, '[1, 2]', "'c1: ships %i'"), each(call, '[1]', "'ships order %i'")), call).not.toBeNull()
      expect(judge(each(call, "[['a', ')(']]", "'c1: ships %s'"), each(call, "[['a', ')(']]", "'ships %s'")), call).toBeNull()
    }
  })

  it('renames the title of test.each with the table over several lines', () => {
    const each = (title: string, row = '[2, 4],') => `test.each([\n  [1, 2],\n  ${row}\n])(${title}, (a, b) => {\n  expect(fulfil(a)).toBe(b)\n})\n`
    expect(judge(each("'c1: doubles %i'"), each('`doubles ${"%i"}`'.replace('${"%i"}', '%i')))).toBeNull()
    expect(judge(each("'c1: doubles %i'"), each("'doubles %i'", '[2, 5],'))).not.toBeNull()
  })

  it('renames a title written on the line after the call', () => {
    const split = (title: string, arg = 'async () => {') => `it(\n  ${title},\n  ${arg}\n    expect(fulfil('ship')).toBeDefined()\n  },\n)\n`
    expect(judge(split("'c1: ships an order'"), split("'ships an order the same day'"))).toBeNull()
    expect(judge(split('`c1: ${"ship"}`'), split('`ships ${"ship"}`'))).toBeNull()
    expect(judge(split("'c1: ships an order'"), split("'ships'", '() => {'))).not.toBeNull()
  })

  it('does not take a string after a closing bracket for a title outside test.each', () => {
    // A curried call's argument is code, not a title.
    const curried = (arg: string) => `it('c1', () => {\n  const ship = fulfil(\n    'ship'\n  )(${arg})\n  expect(ship).toBeDefined()\n})\n`
    expect(judge(curried("'today'"), curried("'never'"))).not.toBeNull()
  })
})

// Found in review: places where something looks like a title but is code.
describe('what is not a title', () => {
  const line = (code: string) => `it('c1', async () => {\n  ${code}\n  expect(await fulfil('ship')).toBeDefined()\n})\n`

  it('is not the first argument of an ordinary method call on an object named like a test call', () => {
    expect(judge(line("context.set('X-Role', 'admin')"), line("context.set('X-None', 'admin')"))).not.toBeNull()
    expect(judge(line('context.get(`/api/${id}/orders`, h)'), line('context.get(`/none/${id}`, h)'))).not.toBeNull()
    const routed = (path: string) => `it('c1', async () => {\n  test.route(\n    ${path},\n    h,\n  )\n})\n`
    expect(judge(routed("'**/api/orders'"), routed("'**/none'"))).not.toBeNull()
  })

  it('is not a test call written inside a template literal, where an expression would run', () => {
    const fixture = (title: string) => `it('c1', async () => {\n  await run(\`\ntest(${title}, () => {})\n\`)\n})\n`
    expect(judge(fixture("'inner'"), fixture("'${process.exit(0)}'"))).not.toBeNull()
  })

  it('keeps an expression that holds a regex, a comment or braces exactly as it was', () => {
    expect(judge(body('`c1 ${/}/.test(a)} ok`'), body('`renamed ${/}/.test(evil())} ok`'))).not.toBeNull()
    expect(judge(body('`c1 ${a /* } */} ok`'), body('`renamed ${a /* } */} ok`'))).not.toBeNull()
  })

  it('stops reading a test.each table at a comment, and compares the rest as written', () => {
    const each = (title: string) => `test.each([\n  [1, 2], // :(\n])(${title}, (a, b) => {\n  expect(fulfil(a)).toBe(b)\n})\n`
    expect(judge(each("'c1: doubles'"), each("'doubles'"))).not.toBeNull()
  })
})

describe('more title forms that may be renamed', () => {
  it('keeps an escaped `\\${` as text', () => {
    expect(judge(body('`c1: \\${not code} ok`'), body('`renamed \\${not code} ok`'))).toBeNull()
  })

  it('renames a title closed right after, as in it.todo', () => {
    expect(judge("it.todo('c1: ships later')\n", "it.todo('ships an order later')\n")).toBeNull()
  })

  it('renames the title of a test.each whose table closes on its own line', () => {
    const each = (title: string) => `test.each([\n  [1, 2],\n])(\n  ${title},\n  (a, b) => {\n    expect(fulfil(a)).toBe(b)\n  },\n)\n`
    expect(judge(each("'c1: doubles %i'"), each("'doubles %i'"))).toBeNull()
  })
})

describe('a command that picks tests by name', () => {
  it('keeps the titles when the command names part of a template title without a filter option', () => {
    expect(judge(body('`c1-ships ${action}`'), body('`ships ${action}`'), `npm test -- ${FROM} c1-ships`)).toMatch(/title/)
  })

  it("knows mocha's --fgrep and --grep-invert", () => {
    for (const flag of ['--fgrep ok', '-f ok', '--grep-invert slow']) {
      expect(judge(body('`${action} ok`'), body('`${action} gone`'), `npx mocha ${FROM} ${flag}`), flag).toMatch(/title/)
    }
  })
})
