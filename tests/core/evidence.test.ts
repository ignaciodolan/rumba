import { describe, expect, it } from 'vitest'
import { hasUnverified, renderPullRequestBody } from '../../src/core/evidence.js'
import { makeDeps, makeRumba, makeTicket, verified } from '../../src/testing/fakes.js'

const d = makeDeps()

describe('renderPullRequestBody', () => {
  it('renders the evidence table and the unverified list', () => {
    const body = renderPullRequestBody({ ticket: makeTicket({ url: 'https://t/1' }), rumba: makeRumba(), state: verified(d), outsideScope: ['packages/ui/y.ts'], secrets: [] })
    expect(body).toContain('| C1 | `npm test -- c1` | fail | pass |')
    expect(body).toMatch(/## Not verified[\s\S]*C2/)
    expect(body).toMatch(/## Outside this rumba's scope[\s\S]*packages\/ui\/y\.ts/)
    expect(body).toContain('https://t/1'); expect(body).toContain('Rumba: hub')
  })
  it('never prints a secret from check output', () => {
    const s = verified(d); s.after![0]!.output = 'Bearer sk-live-999'
    expect(renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: ['sk-live-999'] })).not.toContain('sk-live-999')
  })
  it('omits optional sections when empty', () => {
    const s = verified(d); s.criteria = s.criteria.filter((c) => c.checkable)
    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(body).not.toContain('## Not verified'); expect(body).not.toContain("## Outside this rumba's scope")
  })
  it('keeps ticket text from breaking the table', () => {
    const s = verified(d); s.criteria[0] = { id: 'c1', text: 'a | b\nc', checkable: true }
    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(body).toContain('| a \\| b c | `npm test -- c1` | fail | pass |')
  })
  it('fences output longer than any backtick run in it', () => {
    const s = verified(d); s.after![0]!.output = 'x\n`````\ny'
    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(body).toContain('<details>'); expect(body).toContain('``````\nx\n`````\ny\n``````')
  })
  it('names the environment, agent and model', () => {
    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: verified(d), outsideScope: [], secrets: [] })
    expect(body).toMatch(/## How this was produced[\s\S]*docker[\s\S]*claude-code[\s\S]*default/)
  })
  it('does not change the state it is given', () => {
    const s = verified(d); const copy = structuredClone(s)
    renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(s).toEqual(copy)
  })
})

describe('hasUnverified', () => {
  it('is true for a criterion that cannot be checked, false when all have checks', () => {
    expect(hasUnverified(verified(d))).toBe(true)
    const s = verified(d); s.criteria = s.criteria.filter((c) => c.checkable)
    expect(hasUnverified(s)).toBe(false)
  })
  it('is true for a checkable criterion with no check', () => {
    const s = verified(d); s.criteria[1] = { id: 'c2', text: 'C2', checkable: true }
    expect(hasUnverified(s)).toBe(true)
  })
})
