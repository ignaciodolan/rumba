import { describe, expect, it } from 'vitest'
import { onTheBase } from '../../../src/core/steps/baseRun.js'
import { failing, makeDeps } from '../../../src/testing/fakes.js'

describe('onTheBase', () => {
  const run = { branch: 'rumba/shop/123-review-base', sha: 'sha3', files: ['tests/rumba/c1.test.ts'], what: 'changed', message: 'test: on the base' }

  it('refuses a checkout that is the folder the agent wrote in, before anything runs', async () => {
    const d = makeDeps(); const state = failing(d)
    d.workspace.prepare = async () => ({ workdir: '/fake/agent', baseSha: 'base000' })
    await expect(onTheBase(d, state, { ...run, checks: state.checks, agentDir: '/fake/agent' })).rejects.toThrow('the folder the agent wrote in')
    expect(d.environment.ups).toEqual([]); expect(d.workspace.commits).toEqual([])
  })

  it("sets the files to remove to their content on the base commit, and leaves them out of the hashes", async () => {
    const d = makeDeps(); const state = failing(d)
    const r = await onTheBase(d, state, { ...run, checks: state.checks, agentDir: '/fake/agent', keepFiles: true, fromBase: ['tests/rumba/old.test.ts'] })
    expect(d.workspace.log.filter((l) => l.startsWith('checkout')).map((l) => l.split(' ').slice(2).join(' '))).toEqual(['sha3 tests/rumba/c1.test.ts', 'base000 tests/rumba/old.test.ts'])
    expect(r).toMatchObject({ hashes: { 'tests/rumba/c1.test.ts': 'h0' } })
  })
})
