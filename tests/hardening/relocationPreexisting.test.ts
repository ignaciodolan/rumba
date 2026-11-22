// A live run: the checks for a second ticket reused a fixture that an earlier ticket's checks
// had already put on the default branch (tests/rumba/orders-fixture.ts), where several other
// tests import it. Rumba required every check file to be moved, so the agent moved the
// fixture too, those tests could no longer import it, and `pnpm test` failed: the
// relocation was rejected for a breakage Rumba's own rule forced.
//
// A check file that was already in the repository before Rumba's checks stays where it is.
import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../../src/adapters/agent/prompts.js'
import { judgeRelocation } from '../../src/core/relocation.js'
import { relocateChecks } from '../../src/core/steps/relocateChecks.js'
import type { TicketState } from '../../src/core/types.js'
import { makeDeps, makeRumba, makeTicket, verified } from '../../src/testing/fakes.js'

const FIXTURE = 'tests/rumba/orders-fixture.ts'
const FROM = 'tests/rumba/c3-page.test.tsx'
const TO = 'tests/app/order-page.test.tsx'
const page = (fixture: string) => [
  "import { describe, expect, it } from 'vitest'",
  `import { seedOrder } from '${fixture}'`,
  "import { renderPage } from '@/app/orders/render'",
  '',
  "describe('c3', () => {",
  "  it('c3: shows the order', async () => {",
  '    const p = await seedOrder()',
  '    expect(await renderPage(p.token)).toContain(p.title)',
  '  })',
  '})',
  '',
].join('\n')
const FIXTURE_TEXT = "export async function seedOrder() {\n  return { token: 't', title: 'T' }\n}\n"

function relocation(over: { moves?: { from: string; to: string }[]; files?: string[]; after?: Record<string, string | null>; changed?: string[] } = {}) {
  const moves = over.moves ?? [{ from: FROM, to: TO }]
  return {
    original: [{ criterionId: 'c3', command: `pnpm exec vitest run ${FROM} -t c3`, files: [FROM, FIXTURE] }],
    moves,
    relocated: [{ criterionId: 'c3', command: `pnpm exec vitest run ${TO} -t c3`, files: over.files ?? [TO, FIXTURE] }],
    changed: over.changed ?? [FROM, TO],
    before: { [FROM]: page('./orders-fixture'), [FIXTURE]: FIXTURE_TEXT, [TO]: null, 'tests/common/orders.ts': null } as Record<string, string | null>,
    after: { [FROM]: null, [FIXTURE]: FIXTURE_TEXT, [TO]: page('../rumba/orders-fixture'), 'tests/common/orders.ts': null, ...over.after } as Record<string, string | null>,
    protectedGlobs: [],
    kept: [FIXTURE],
  }
}

describe('a check file that was in the repository before the checks', () => {
  it('stays where it is, and the moved check imports it from there', () => {
    expect(judgeRelocation(relocation())).toBeNull()
  })

  it('may not be moved, since other code may import it', () => {
    const r = relocation({
      moves: [{ from: FROM, to: TO }, { from: FIXTURE, to: 'tests/common/orders.ts' }],
      files: [TO, 'tests/common/orders.ts'],
      changed: [FROM, TO, FIXTURE, 'tests/common/orders.ts'],
      after: { [FIXTURE]: null, 'tests/common/orders.ts': FIXTURE_TEXT, [TO]: page('../common/orders') },
    })
    expect(judgeRelocation(r)).toMatch(/was in the repository before Rumba's checks/)
  })

  it('may not be changed', () => {
    const r = relocation({ changed: [FROM, TO, FIXTURE], after: { [FIXTURE]: `${FIXTURE_TEXT}export const extra = 1\n` } })
    expect(judgeRelocation(r)).not.toBeNull()
  })

  it('stays among the relocated check\'s files', () => {
    expect(judgeRelocation(relocation({ files: [TO] }))).toMatch(/exactly its new files/)
  })
})

describe('the relocation step', () => {
  function setup() {
    const d = makeDeps()
    const state: TicketState = { ...verified(d), checks: [{ criterionId: 'c1', command: `pnpm exec vitest run ${FROM} -t c3`, files: [FROM, FIXTURE] }], checkHashes: { [FROM]: 'h' } }
    state.criteria = [{ id: 'c1', text: 'C1', checkable: true }]
    d.workspace.branchTip = 'fix000'
    d.workspace.commitResults = ['reloc00', 'relbase']
    d.workspace.changed = [FROM, TO]
    d.workspace.changedSince = { base000: [FROM, 'app/p/render.ts'] }
    d.workspace.files = {
      base000: { [FIXTURE]: FIXTURE_TEXT },
      fix000: { [FROM]: page('./orders-fixture'), [FIXTURE]: FIXTURE_TEXT },
      reloc00: { [TO]: page('../rumba/orders-fixture'), [FIXTURE]: FIXTURE_TEXT },
    }
    return { d, state }
  }

  it('tells the agent which check files were already there and stay, and keeps a move that leaves them', async () => {
    const { d, state } = setup()
    d.agent.script['relocate-checks'] = { kind: 'relocate-checks', moves: [{ from: FROM, to: TO }], checks: [{ criterionId: 'c1', command: `pnpm exec vitest run ${TO} -t c3`, files: [TO, FIXTURE] }] }
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(d.agent.calls[0]!.lockedFiles).toEqual([FIXTURE])
    expect(s.relocation?.status).toBe('relocated')
  })

  it('rejects a move of a check file that was already there', async () => {
    const { d, state } = setup()
    d.workspace.changed = [FROM, TO, FIXTURE, 'tests/common/orders.ts']
    d.workspace.files.reloc00 = { [TO]: page('../common/orders'), 'tests/common/orders.ts': FIXTURE_TEXT }
    d.agent.script['relocate-checks'] = {
      kind: 'relocate-checks',
      moves: [{ from: FROM, to: TO }, { from: FIXTURE, to: 'tests/common/orders.ts' }],
      checks: [{ criterionId: 'c1', command: `pnpm exec vitest run ${TO} -t c3`, files: [TO, 'tests/common/orders.ts'] }],
    }
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(s.relocation?.reason).toMatch(/was in the repository before Rumba's checks/)
    expect(d.environment.ups).toEqual([])
  })
})

describe('the relocate-checks prompt', () => {
  it('names the check files that stay where they are', () => {
    const p = buildPrompt({
      kind: 'relocate-checks', ticket: makeTicket(), context: '', environmentKind: 'docker',
      checks: [{ criterionId: 'c3', command: `pnpm exec vitest run ${FROM} -t c3`, files: [FROM, FIXTURE] }],
      lockedFiles: [FIXTURE],
    })
    expect(p).toMatch(/were in the repository before Rumba's checks[\s\S]*tests\/rumba\/orders-fixture\.ts/)
    expect(p).toMatch(/Leave them where they are, unchanged/)
    expect(p).toMatch(/Move every other check file listed above/)
  })
})

describe('after review: kept files stay unchanged', () => {
  it('refuses a move into a kept file', () => {
    const OLD = 'tests/rumba/c1.test.ts'
    const old = "import { expect, it } from 'vitest'\n\nit('c1 old', () => {\n  expect(1).toBe(1)\n})\n"
    const moved = page('./orders-fixture').replace(/^import \{ describe, expect, it \} from 'vitest'\n/, '')
    const r = judgeRelocation({
      original: [{ criterionId: 'c3', command: `pnpm exec vitest run ${FROM} -t c3`, files: [FROM, OLD] }],
      moves: [{ from: FROM, to: OLD }],
      relocated: [{ criterionId: 'c3', command: `pnpm exec vitest run ${OLD} -t c3`, files: [OLD] }],
      changed: [FROM, OLD],
      before: { [FROM]: page('./orders-fixture'), [OLD]: old },
      after: { [FROM]: null, [OLD]: `${old}\n${moved}` },
      protectedGlobs: [],
      kept: [OLD],
    })
    expect(r).toMatch(/must stay where it is|Rumba's own check files/)
  })

  it('rewrites a moved path in the command without touching a kept path that starts with it', () => {
    const KEPT = 'tests/rumba/c3-page.test.tsx.snap'
    const r = judgeRelocation({
      ...relocation(),
      original: [{ criterionId: 'c3', command: `pnpm exec vitest run ${FROM} -t c3 --snap ${KEPT}`, files: [FROM, FIXTURE] }],
      relocated: [{ criterionId: 'c3', command: `pnpm exec vitest run ${TO} -t c3 --snap ${KEPT}`, files: [TO, FIXTURE] }],
    })
    expect(r).toBeNull()
  })
})

describe('after review: the step', () => {
  function base() {
    const d = makeDeps()
    const state: TicketState = { ...verified(d), checks: [{ criterionId: 'c1', command: `pnpm exec vitest run ${FROM} -t c3`, files: [FROM, FIXTURE] }], checkHashes: { [FROM]: 'h' } }
    state.criteria = [{ id: 'c1', text: 'C1', checkable: true }]
    d.workspace.branchTip = 'fix000'
    d.workspace.changedSince = { base000: [FROM] }
    return { d, state }
  }

  it('does not run the agent when every check file was already in the repository', async () => {
    const { d, state } = base()
    d.workspace.files = { base000: { [FROM]: 'x', [FIXTURE]: FIXTURE_TEXT } }
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(d.agent.calls).toHaveLength(0)
    expect(s.relocation?.reason).toMatch(/nothing to move/)
  })

  it('rejects the relocation when it cannot tell whether a check file was there before', async () => {
    const { d, state } = base()
    d.workspace.readFileAt = async () => { throw new Error('git failed') }
    const s = await relocateChecks(d, makeRumba(), makeTicket(), state)
    expect(d.agent.calls).toHaveLength(0)
    expect(s.relocation?.reason).toMatch(/git failed/)
  })
})
