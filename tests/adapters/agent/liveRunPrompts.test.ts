import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../../../src/adapters/agent/prompts.js'
import { makeTicket } from '../../../src/testing/fakes.js'

const criteria = [{ id: 'c1', text: 'C1', checkable: true }]

describe('where a docker check runs', () => {
  it("tells the check writer that checks run in the project's container through the exec prefix", () => {
    const p = buildPrompt({ kind: 'write-checks', ticket: makeTicket(), context: '', environmentKind: 'docker', criteria, execPrefix: 'docker compose -f .rumba/shop/compose.yml exec -T app' })
    expect(p).toContain("Rumba runs each check inside the project's container, not in this sandbox, as: docker compose -f .rumba/shop/compose.yml exec -T app sh -c '<command>'")
    expect(p).toContain('You cannot run the checks there yourself')
    expect(p).not.toContain('run from the repository root')
  })
  it('says the same to the fixer, who also cannot run them', () => {
    const p = buildPrompt({ kind: 'fix', ticket: makeTicket(), context: '', environmentKind: 'docker', criteria, checks: [], execPrefix: 'docker compose exec -T app' })
    expect(p).toContain("Rumba runs each check inside the project's container, not in this sandbox, as: docker compose exec -T app sh -c '<command>'")
  })
  it('says nothing of a container for a preview', () => {
    const p = buildPrompt({ kind: 'write-checks', ticket: makeTicket(), context: '', environmentKind: 'vercel-preview', criteria })
    expect(p).not.toContain("project's container")
  })
})

describe('triage and written criteria', () => {
  it('asks triage to name the written criteria a command cannot check, and why', () => {
    const p = buildPrompt({ kind: 'triage', ticket: makeTicket(), context: '', environmentKind: 'docker', criteria: [{ id: 'c1', text: 'Nothing calls the network', checkable: true }] })
    expect(p).toContain('- c1: Nothing calls the network')
    expect(p).toContain('"notCheckable"')
    expect(p).toMatch(/constraint on how the work is done/)
  })
})
