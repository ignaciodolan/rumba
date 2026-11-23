import { describe, expect, it } from 'vitest'
import { buildPrompt } from '../../../src/adapters/agent/prompts.js'
import { advanceTicket } from '../../../src/core/engine.js'
import { runRumba } from '../../../src/core/runner.js'
import { renderPullRequestBody } from '../../../src/core/evidence.js'
import { revise } from '../../../src/core/steps/revise.js'
import { trackPullRequest } from '../../../src/core/steps/trackPullRequest.js'
import type { Feedback } from '../../../src/core/types.js'
import { AgentError } from '../../../src/ports/agent.js'
import { InfrastructureError } from '../../../src/ports/environment.js'
import { aliceReview, changesRequested, makeDeps, makeRumba, makeTicket, REVIEWED_PR } from '../../../src/testing/fakes.js'

const PR = REVIEWED_PR
const CHECK = 'tests/rumba/c1.test.ts'
const revised = { kind: 'revise' as const, summary: 'Renamed total to subtotal.', replies: [{ item: 1, reply: 'Renamed it.' }] }
const bobLine: Feedback = { kind: 'line', author: 'bob', url: `${PR}#discussion_r2`, at: '2025-12-31T12:05:00Z', text: 'Use a constant here.', path: 'src/cart.ts', line: 12 }
const aliceComment: Feedback = { kind: 'comment', author: 'alice', url: `${PR}#issuecomment-3`, at: '2025-12-31T12:10:00Z', text: 'Also update the docs.' }

/** Deps for a round on changesRequested(d): the fix commit 'sha2' is the branch head, and attempts commit 'sha3', 'sha4'. */
function setup() {
  const d = makeDeps()
  d.agent.script.revise = revised
  d.workspace.hashes = { [CHECK]: 'h1' }
  d.workspace.commitResults = ['sha3', 'sha4']
  return d
}

describe('revise', () => {
  it('revises on the same branch and the same pull request, without opening another', async () => {
    const d = setup(); const diffs: { since: string; max: number }[] = []
    d.workspace.diffText = 'diff --git a/src/cart.ts b/src/cart.ts'
    const diff = d.workspace.diff.bind(d.workspace)
    d.workspace.diff = async (w, since, max) => { diffs.push({ since, max }); return diff(w, since, max) }
    const start = changesRequested(d)
    const s = await revise(d, makeRumba(), makeTicket(), start)

    expect(s.state).toBe('pr_open'); expect(s.pullRequestUrl).toBe(PR)
    expect(d.codeHost.prs).toHaveLength(0)
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/shop/123', force: false }])
    expect(d.workspace.log.filter((l) => l.startsWith('prepare')).every((l) => l.startsWith('prepare rumba/shop/123 existing'))).toBe(true)
    expect(s.history.slice(-3).map((h) => h.state)).toEqual(['building', 'verified', 'pr_open'])
    expect(s).toMatchObject({ reviewRounds: 1, pushedAt: '2026-01-01T00:00:00.000Z', fixSummary: 'Renamed total to subtotal.', after: [expect.objectContaining({ criterionId: 'c1', passed: true })] })
    expect(s).not.toHaveProperty('feedback')
    expect(d.agent.calls).toHaveLength(1)
    expect(d.agent.calls[0]).toMatchObject({
      kind: 'revise', feedback: [aliceReview], diff: 'diff --git a/src/cart.ts b/src/cart.ts', lockedFiles: [CHECK],
      criteria: start.criteria, checks: start.checks, failures: [], attempt: 1,
    })
    expect(diffs).toEqual([{ since: 'base000', max: 30000 }])
    expect(d.tracker.states.get('123')).toEqual(s)
  })

  it('leaves every check and the project tests passing after a round', async () => {
    const d = setup()
    const s = await revise(d, makeRumba({ verify: { test: 'npm test' } }), makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open')
    expect(s.after?.every((r) => r.passed)).toBe(true)
    expect(d.environment.commandsRun).toEqual(['npm test'])
    expect(s.attempts?.at(-1)).toMatchObject({ outcome: 'verified', projectTests: 'passed' })
  })

  it('gives the failures of one attempt to the next', async () => {
    const d = setup()
    // Both verification runs of the first attempt fail.
    d.environment.checkResults = [{ passed: false, output: 'expected subtotal' }, { passed: false, output: 'expected subtotal' }]
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open')
    expect(d.agent.calls[1]).toMatchObject({ attempt: 2, failures: [{ criterionId: 'c1', output: 'expected subtotal' }] })
    expect(d.environment.ups.map((u) => u.sha)).toEqual(['sha3', 'sha3', 'sha4'])
  })

  it('ends a round that fails every attempt in needs_human, with the failure on the ticket, the branch reset and nothing pushed', async () => {
    const d = setup(); d.environment.passes = () => false
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('needs_human')
    expect(d.tracker.states.get('123')?.state).toBe('needs_human')
    expect(d.agent.calls).toHaveLength(2)
    expect(d.codeHost.pushed).toEqual([]); expect(d.codeHost.updates).toEqual([]); expect(d.codeHost.pullRequestComments).toEqual([])
    expect(d.workspace.branchTip).toBe('sha2'); expect(d.workspace.resets.at(-1)).toBe('sha2')
    expect(d.tracker.comments.at(-1)?.body).toBe([
      `Rumba could not revise the pull request: the checks still fail after 2 attempts. The branch is back where it was before this round, and nothing was pushed: ${PR}`, '',
      '- Attempt 1: checks failed (c1 failed)',
      '- Attempt 2: checks failed (c1 failed)', '',
      'Last failures:', '',
      'c1:\ncheck failed',
    ].join('\n'))
  })

  it('updates the pull request body from the new state', async () => {
    const d = setup()
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(d.codeHost.updates).toEqual([{ url: PR, body }])
    expect(body).toContain('> Renamed total to subtotal.')
  })

  it('replies on the pull request with one line per piece of feedback, in order', async () => {
    const d = setup()
    d.agent.script.revise = { ...revised, replies: [{ item: 3, reply: 'Updated the docs.' }, { item: 1, reply: 'Renamed it.' }, { item: 9, reply: 'No such item.' }] }
    await revise(d, makeRumba(), makeTicket(), changesRequested(d, [aliceReview, bobLine, aliceComment]))
    expect(d.codeHost.pullRequestComments).toEqual([{
      url: PR,
      body: [
        `- Review by alice (${PR}#pullrequestreview-1): Renamed it.`,
        `- Line comment on src/cart.ts:12 by bob (${PR}#discussion_r2): No reply from the agent.`,
        `- Comment by alice (${PR}#issuecomment-3): Updated the docs.`,
      ].join('\n'),
    }])
  })

  it('makes the replies inert, on one line and at most 500 characters', async () => {
    const d = setup(); d.agent.script.revise = { ...revised, replies: [{ item: 1, reply: 'Thanks @carol, see #7 and <b>this</b>\n![x](https://evil.test/x.png) s3cr3t' }, { item: 2, reply: 'a'.repeat(600) }] }
    d.secrets = ['s3cr3t']
    await revise(d, makeRumba(), makeTicket(), changesRequested(d, [aliceReview, aliceComment]))
    const [first, second] = d.codeHost.pullRequestComments[0]!.body.split('\n')
    expect(first).toBe(`- Review by alice (${PR}#pullrequestreview-1): Thanks @​carol, see #​7 and &lt;b&gt;this&lt;/b&gt; !​[x](https://evil.test/x.png) [redacted]`)
    expect(second).toBe(`- Comment by alice (${PR}#issuecomment-3): ${'a'.repeat(500)}`)
  })

  it('replies with one line for a round asked for with the label alone', async () => {
    const d = setup()
    await revise(d, makeRumba(), makeTicket(), changesRequested(d, []))
    expect(d.codeHost.pullRequestComments).toEqual([{ url: PR, body: 'Revised as asked with the rumba-revise label.' }])
  })

  it('stops before a third round with the default limit, without running the agent', async () => {
    const d = setup()
    const s = await revise(d, makeRumba(), makeTicket(), { ...changesRequested(d), reviewRounds: 2 })
    expect(s.state).toBe('needs_human'); expect(s.reviewRounds).toBe(2)
    expect(d.agent.calls).toHaveLength(0); expect(d.codeHost.pushed).toEqual([])
    expect(d.tracker.states.get('123')?.state).toBe('needs_human')
    expect(d.tracker.comments.at(-1)?.body).toBe(`Rumba stopped revising this pull request: it already ran 2 review rounds, the most allowed. A person needs to take it from here: ${PR}`)
  })

  it('posts a no-change answer, pushes nothing and goes back to pr_open', async () => {
    const d = setup(); d.workspace.commitResults = [null]
    d.agent.script.revise = { kind: 'revise', summary: 'Nothing to change.', replies: [{ item: 1, reply: 'The API uses that name.' }], noChangeNeeded: 'total is the name the API returns.' }
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open'); expect(s.reviewRounds).toBe(1)
    expect(s.pushedAt).toBe('2025-12-31T00:00:00.000Z'); expect(s.fixSummary).toBe('fixed')
    expect(d.codeHost.pushed).toEqual([]); expect(d.codeHost.updates).toEqual([]); expect(d.environment.ups).toEqual([])
    expect(d.tracker.states.get('123')?.state).toBe('pr_open')
    expect(d.codeHost.pullRequestComments).toEqual([{
      url: PR,
      body: [
        "Rumba made no change in this round. The agent's reason:", '',
        '> total is the name the API returns.', '',
        `- Review by alice (${PR}#pullrequestreview-1): The API uses that name.`,
      ].join('\n'),
    }])
  })

  it('puts the feedback text in the prompt only inside the reviewer section', async () => {
    const d = setup()
    await revise(d, makeRumba({ context: 'The shop sells shoes.' }), makeTicket(), changesRequested(d))
    const prompt = buildPrompt(d.agent.calls[0]!)
    const at = prompt.indexOf(aliceReview.text)
    expect(at).toBeGreaterThan(prompt.indexOf('# Feedback from reviewers'))
    expect(at).toBeLessThan(prompt.indexOf('# The change so far'))
    expect(prompt.lastIndexOf(aliceReview.text)).toBe(at)
  })

  it('rejects a change to a protected path since the round started, and resets to that head', async () => {
    const d = setup(); d.workspace.changedSince = { sha2: ['.github/workflows/ci.yml'] }
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toEqual([])
    expect(d.workspace.resets).toEqual(['sha2', 'sha2', 'sha2'])
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'guard', output: 'The fix changed protected paths, which the agent must not change: .github/workflows/ci.yml' }])
  })

  it('rejects a changed check file the agent did not declare', async () => {
    const d = setup(); d.workspace.changedSince = { sha2: [CHECK] }
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toEqual([])
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'guard', output: `The change edited check files, which must stay as written: ${CHECK}` }])
    expect(d.workspace.branchTip).toBe('sha2')
  })

  /** The round locks the check at h1; every later hash sees the check as the attempt changed it. */
  function changedCheck(d: ReturnType<typeof setup>): void {
    let n = 0
    d.workspace.hashFiles = async (_w, files) => Object.fromEntries(files.map((f) => [f, n++ === 0 ? 'h1' : 'h2']))
    d.workspace.changedSince = { sha2: [CHECK] }
    d.agent.script.revise = { ...revised, checkChanges: [{ criterionId: 'c1', reason: 'alice says the check is wrong' }] }
    // The attempt's commit, then the commit of the changed check on the base.
    d.workspace.commitResults = ['sha3', 'base-c1', 'sha4', 'base-c1b']
  }

  it('accepts a declared check change that fails on the base and passes on the change, and says so on the pull request', async () => {
    const d = setup(); changedCheck(d)
    d.environment.checkResults = [{ passed: false, output: 'expected subtotal, got total' }]
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))

    expect(s.state).toBe('pr_open'); expect(d.agent.calls).toHaveLength(1)
    expect(d.environment.ups).toEqual([
      { branch: 'rumba/shop/123-review-base', sha: 'base-c1', role: 'before' },
      { branch: 'rumba/shop/123', sha: 'sha3', role: 'after' },
    ])
    const scratch = d.workspace.log.find((l) => l.startsWith('prepare rumba/shop/123-review-base'))!
    expect(scratch).toMatch(/^prepare rumba\/shop\/123-review-base fresh like rumba\/shop\/123 /)
    const dir = scratch.split(' ').at(-1)!
    // The checks commit, with the check as the attempt changed it.
    expect(d.workspace.log).toContain(`reset ${dir} sha1`)
    expect(d.workspace.log).toContain(`checkout ${dir} sha3 ${CHECK}`)
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/shop/123', force: false }])

    expect(s.checks).toEqual([{ criterionId: 'c1', command: 'npm test -- c1', files: [CHECK], changedAfterReview: true }])
    expect(s.before).toEqual([{ criterionId: 'c1', passed: false, exitCode: 1, output: 'expected subtotal, got total' }])
    expect(s.checkHashes).toEqual({ [CHECK]: 'h2' })
    expect(d.tracker.states.get('123')).toEqual(s)

    const body = renderPullRequestBody({ ticket: makeTicket(), rumba: makeRumba(), state: s, outsideScope: [], secrets: [] })
    expect(d.codeHost.updates).toEqual([{ url: PR, body }])
    expect(body).toContain(`\`${CHECK}\` (changed after review)`)
    expect(body).toContain('expected subtotal, got total')
    expect(d.codeHost.pullRequestComments).toEqual([{
      url: PR,
      body: [`- Review by alice (${PR}#pullrequestreview-1): Renamed it.`, '- Check for c1 changed: alice says the check is wrong'].join('\n'),
    }])
  })

  it.each([
    ['passes there', { passed: true }, 'The changed check for c1 passes on the base commit, so it no longer shows the problem.'],
    ['cannot run there', { passed: false, exitCode: 127 }, 'The changed check for c1 could not run on the base commit (exit 127).'],
    ['dies of the machine there', { passed: false, infrastructure: 'the machine ran out of memory' }, 'The changed check for c1 could not be judged on the base commit: the machine ran out of memory.'],
  ])('rejects a declared check change whose check %s, and gives the reason to the next attempt', async (_what, base, reason) => {
    const d = setup(); changedCheck(d)
    d.environment.checkResults = [base, base]
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('needs_human')
    // Only the base runs: a change that is refused there is never verified.
    expect(d.environment.ups.map((u) => u.role)).toEqual(['before', 'before'])
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'c1', output: reason }])
    expect(s.attempts?.map((a) => a.outcome)).toEqual(['guard', 'guard'])
    expect(s.attempts?.[0]?.note).toBe(reason)
    expect(d.workspace.branchTip).toBe('sha2'); expect(d.codeHost.pushed).toEqual([])
    expect(s.checks[0]!.changedAfterReview).toBeUndefined(); expect(s.checkHashes).toEqual({ [CHECK]: 'h1' })
  })

  it('rejects a declared check change that deletes the check file', async () => {
    const d = setup(); changedCheck(d)
    let n = 0
    d.workspace.hashFiles = async (_w, files) => (n++ === 0 ? Object.fromEntries(files.map((f) => [f, 'h1'])) : {})
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toEqual([])
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'c1', output: `The changed check for c1 lost its file ${CHECK}: a check may change, but not lose its files.` }])
    expect(d.workspace.branchTip).toBe('sha2')
  })

  it('ignores a declared criterion that has no check: it exempts nothing and is not replied about', async () => {
    const d = setup(); d.workspace.changedSince = { sha2: [CHECK] }
    // c2 is a criterion without a check, c9 no criterion at all.
    d.agent.script.revise = { ...revised, checkChanges: [{ criterionId: 'c2', reason: 'no check' }, { criterionId: 'c9', reason: 'made up' }] }
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toEqual([])
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'guard', output: `The change edited check files, which must stay as written: ${CHECK}` }])

    const e = setup(); e.agent.script.revise = { ...revised, checkChanges: [{ criterionId: 'c9', reason: 'made up' }] }
    const t = await revise(e, makeRumba(), makeTicket(), changesRequested(e))
    expect(t.state).toBe('pr_open'); expect(e.environment.ups.map((u) => u.role)).toEqual(['after'])
    expect(t.checks[0]!.changedAfterReview).toBeUndefined()
    expect(e.codeHost.pullRequestComments[0]!.body).toBe(`- Review by alice (${PR}#pullrequestreview-1): Renamed it.`)
  })

  it("lets a declared change exempt only that criterion's check files, never another check's or a protected path", async () => {
    const other = 'tests/rumba/c3.test.ts'
    const withC3 = (d: ReturnType<typeof setup>) => {
      const s = changesRequested(d)
      return { ...s, criteria: [...s.criteria, { id: 'c3', text: 'C3', checkable: true }], checks: [...s.checks, { criterionId: 'c3', command: 'npm test -- c3', files: [other] }] }
    }
    const d = setup(); changedCheck(d); d.workspace.changedSince = { sha2: [CHECK, other] }
    expect((await revise(d, makeRumba(), makeTicket(), withC3(d))).state).toBe('needs_human')
    expect(d.environment.ups).toEqual([])
    expect(d.agent.calls[1]!.failures).toEqual([{ criterionId: 'guard', output: `The change edited check files, which must stay as written: ${other}` }])

    const e = setup(); changedCheck(e); e.workspace.changedSince = { sha2: [CHECK, '.github/workflows/ci.yml'] }
    expect((await revise(e, makeRumba(), makeTicket(), changesRequested(e))).state).toBe('needs_human')
    expect(e.environment.ups).toEqual([])
    expect(e.agent.calls[1]!.failures?.[0]?.output).toContain('.github/workflows/ci.yml')
  })

  it('runs on the base every check that shares a changed file with a declared one', async () => {
    const shared = 'tests/cart.test.ts'
    const d = setup(); changedCheck(d); d.workspace.changedSince = { sha2: [shared] }
    const start = changesRequested(d)
    const s = await revise(d, makeRumba(), makeTicket(), {
      ...start,
      criteria: [...start.criteria, { id: 'c3', text: 'C3', checkable: true }],
      checks: [{ criterionId: 'c1', command: 'npm test -- cart -t c1', files: [shared] }, { criterionId: 'c3', command: 'npm test -- cart -t c3', files: [shared] }],
      before: [...start.before!, { criterionId: 'c3', passed: false, exitCode: 1, output: 'old c3' }],
    })
    expect(s.state).toBe('pr_open')
    expect(d.environment.checksRun.slice(0, 2)).toEqual(['c1', 'c3'])
    expect(s.checks.map((c) => c.changedAfterReview)).toEqual([true, true])
    expect(s.before?.map((r) => r.output)).toEqual(['check failed', 'check failed'])
    expect(d.codeHost.pullRequestComments[0]!.body.split('\n').filter((l) => l.startsWith('- Check'))).toEqual(['- Check for c1 changed: alice says the check is wrong'])
  })

  it('makes the reason of a check change inert, on one line and at most 500 characters, also after the label line', async () => {
    const d = setup(); changedCheck(d); d.secrets = ['s3cr3t']
    d.agent.script.revise = { ...revised, checkChanges: [{ criterionId: 'c1', reason: `@alice said so, see #7\n<b>s3cr3t</b> ${'a'.repeat(600)}` }] }
    await revise(d, makeRumba(), makeTicket(), changesRequested(d, []))
    const [label, line] = d.codeHost.pullRequestComments[0]!.body.split('\n')
    expect(label).toBe('Revised as asked with the rumba-revise label.')
    const raw = `@alice said so, see #7 <b>[redacted]</b> ${'a'.repeat(600)}`.slice(0, 500)
    expect(line).toBe(`- Check for c1 changed: ${raw.replace('@', '@\u200b').replace('#7', '#\u200b7').replace('<b>', '&lt;b&gt;').replace('</b>', '&lt;/b&gt;')}`)
  })

  it('takes a declared change made in an earlier attempt of the round as still declared, and proves it again', async () => {
    const d = setup(); changedCheck(d)
    // The first attempt's change fails on the change; the second keeps the changed check without declaring it again.
    d.agent.script.revise = [{ ...revised, checkChanges: [{ criterionId: 'c1', reason: 'alice says the check is wrong' }] }, revised]
    d.environment.checkResults = [{ passed: false }, { passed: false, output: 'still wrong' }, { passed: false, output: 'still wrong' }]
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open')
    expect(d.environment.ups.map((u) => `${u.role} ${u.sha}`)).toEqual(['before base-c1', 'after sha3', 'after sha3', 'before base-c1b', 'after sha4'])
    expect(s.checks[0]!.changedAfterReview).toBe(true)
    expect(d.codeHost.pullRequestComments[0]!.body).toContain('- Check for c1 changed: alice says the check is wrong')
  })

  it('locks the check files as the branch head holds them when the round starts', async () => {
    const d = setup(); let n = 0
    // The first hash is the lock; every later one sees the check edited.
    d.workspace.hashFiles = async (_w, files) => Object.fromEntries(files.map((f) => [f, n++ === 0 ? 'h-round' : 'EDITED']))
    const start = { ...changesRequested(d), checks: [{ criterionId: 'c1', command: 'npm test -- cart', files: ['tests/cart.test.ts'] }] }
    const s = await revise(d, makeRumba(), makeTicket(), start)
    expect(s.checkHashes).toEqual({ 'tests/cart.test.ts': 'h-round' })
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toEqual([])
    expect(d.agent.calls[0]!.lockedFiles).toEqual(['tests/cart.test.ts'])
    expect(d.agent.calls[1]!.failures?.[0]!.output).toContain('tests/cart.test.ts')
  })

  it('counts the round before the agent runs, and resets the branch when the round dies', async () => {
    const d = setup(); d.environment.passes = () => false
    d.agent.script.revise = [revised, new AgentError("The reviewers' feedback does not fit in the prompt.")]
    await expect(revise(d, makeRumba(), makeTicket(), changesRequested(d))).rejects.toThrow(/does not fit/)
    expect(d.tracker.states.get('123')).toMatchObject({ state: 'building', reviewRounds: 1 })
    expect(d.workspace.branchTip).toBe('sha2')
  })

  it('stops for the machine as building does, with the attempt recorded and the branch reset', async () => {
    const d = setup(); const oom = { passed: false, infrastructure: 'the machine ran out of memory' }
    d.environment.checkResults = [oom, oom]
    await expect(revise(d, makeRumba(), makeTicket(), changesRequested(d))).rejects.toBeInstanceOf(InfrastructureError)
    expect(d.tracker.states.get('123')?.attempts?.at(-1)?.outcome).toBe('infrastructure')
    expect(d.workspace.branchTip).toBe('sha2')
  })

  it('keeps the round when the body update or the reply fails', async () => {
    const d = setup()
    d.codeHost.updatePullRequest = async () => { throw new Error('GitHub is down') }
    d.codeHost.commentOnPullRequest = async () => { throw new Error('GitHub is down') }
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open'); expect(d.tracker.states.get('123')?.state).toBe('pr_open')
  })

  /** A round that starts at 10:00 and whose agent runs until 11:00. */
  function timed(d: ReturnType<typeof setup>): void {
    let now = new Date('2026-01-01T10:00:00Z'); d.clock = () => now
    const run = d.agent.run.bind(d.agent)
    d.agent.run = async (task, w) => { now = new Date('2026-01-01T11:00:00Z'); return run(task, w) }
  }

  it("records the round's start as the time it answered, on success and on a no-change answer", async () => {
    const d = setup(); timed(d)
    expect(await revise(d, makeRumba(), makeTicket(), changesRequested(d))).toMatchObject({ answeredAt: '2026-01-01T10:00:00.000Z', pushedAt: '2026-01-01T11:00:00.000Z' })
    const e = setup(); timed(e); e.workspace.commitResults = [null]
    e.agent.script.revise = { ...revised, noChangeNeeded: 'total is the name the API returns.' }
    expect((await revise(e, makeRumba(), makeTicket(), changesRequested(e))).answeredAt).toBe('2026-01-01T10:00:00.000Z')
  })

  it('starts the next round on a review written while the round ran', async () => {
    const d = setup(); timed(d)
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    d.codeHost.feedback.set(PR, [{ ...aliceReview, reviewState: 'changes_requested', at: '2026-01-01T10:30:00Z', text: 'One more thing.', canWrite: true, self: false }])
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), s)).state).toBe('changes_requested')
  })

  it('takes a revise label added while the round ran as a new request, not as stale', async () => {
    const d = setup(); timed(d)
    const s = await revise(d, makeRumba(), makeTicket(), changesRequested(d))
    d.codeHost.pullRequests.set(PR, { state: 'open', headSha: 'sha3', labels: ['rumba-revise'] })
    // A label from someone without write access starts nothing, and is not removed as stale either.
    d.codeHost.labelEvents.set(PR, { by: 'tess', at: '2026-01-01T10:30:00Z', canWrite: false, self: false })
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), s)).state).toBe('pr_open')
    expect(d.codeHost.labelsRemoved).toEqual([])
    d.codeHost.labelEvents.set(PR, { by: 'alice', at: '2026-01-01T10:30:00Z', canWrite: true, self: false })
    expect((await trackPullRequest(d, makeRumba(), makeTicket(), s)).state).toBe('changes_requested')
  })

  it('pushes without force, and leaves the ticket for the next run when the remote moved', async () => {
    const d = setup(); d.tracker.tickets.push(makeTicket()); d.tracker.states.set('123', changesRequested(d))
    d.codeHost.pushBranch = async (_w, branch, opts) => { d.codeHost.pushed.push({ branch, force: opts?.force ?? false }); throw new Error('rejected: non-fast-forward') }
    const r = await runRumba(d, makeRumba())
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/shop/123', force: false }])
    expect(r.left).toEqual([{ ticket: '123', why: 'error: rejected: non-fast-forward' }])
    expect(d.tracker.states.get('123')).toMatchObject({ state: 'changes_requested', errorCount: 1, reviewRounds: 1 })
    expect(d.codeHost.updates).toEqual([]); expect(d.codeHost.pullRequestComments).toEqual([])
  })

  it('does not start another round on the review a no-change answer answered, but does on a newer one', async () => {
    const d = setup(); d.workspace.commitResults = [null]
    d.agent.script.revise = { ...revised, noChangeNeeded: 'total is the name the API returns.' }
    d.tracker.tickets.push(makeTicket()); d.tracker.states.set('123', changesRequested(d))
    const review = { ...aliceReview, reviewState: 'changes_requested' as const, canWrite: true, self: false }
    d.codeHost.feedback.set(PR, [review])
    expect((await runRumba(d, makeRumba())).advanced).toEqual([{ ticket: '123', from: 'changes_requested', to: 'pr_open' }])
    expect((await runRumba(d, makeRumba())).left).toEqual([{ ticket: '123', why: 'pull request open' }])
    d.codeHost.feedback.set(PR, [review, { ...review, url: `${PR}#pullrequestreview-4`, at: '2026-01-01T01:00:00Z', text: 'Still wrong.' }])
    expect((await runRumba(d, makeRumba())).advanced).toEqual([{ ticket: '123', from: 'pr_open', to: 'changes_requested' }])
    expect(d.tracker.states.get('123')?.feedback?.map((f) => f.text)).toEqual(['Still wrong.'])
  })

  it("starts the round from the pull request's head, not from a commit a killed run left on the branch", async () => {
    const d = setup(); const start = changesRequested(d)
    // A person pushed sha9 to the branch; the local branch still holds an unpushed sha2.
    d.codeHost.pullRequests.set(PR, { state: 'open', headSha: 'sha9' })
    d.environment.passes = () => false
    const s = await revise(d, makeRumba(), makeTicket(), start)
    expect(d.workspace.syncs).toEqual([{ branch: 'rumba/shop/123', sha: 'sha9' }])
    expect(d.environment.ups.map((u) => u.sha)).toEqual(['sha3', 'sha3', 'sha4', 'sha4'])
    expect(s.state).toBe('needs_human')
    expect(d.workspace.resets).toEqual(['sha9']); expect(d.workspace.branchTip).toBe('sha9')
  })

  it("guards against changes since the pull request's head and resets there", async () => {
    const d = setup(); const start = changesRequested(d)
    d.codeHost.pullRequests.set(PR, { state: 'open', headSha: 'sha9' })
    d.workspace.changedSince = { sha9: ['.github/workflows/ci.yml'] }
    const s = await revise(d, makeRumba(), makeTicket(), start)
    expect(s.state).toBe('needs_human'); expect(d.environment.ups).toEqual([])
    expect(d.workspace.resets).toEqual(['sha9', 'sha9', 'sha9'])
  })

  it("numbers a round's attempts from 1, whatever the ticket's earlier attempts", async () => {
    const d = setup(); d.environment.passes = () => false
    const earlier = { outcome: 'checks-failed' as const, checks: [], projectTests: 'not-run' as const, tail: '' }
    const s = await revise(d, makeRumba(), makeTicket(), { ...changesRequested(d), attempts: [{ n: 1, ...earlier }, { n: 2, ...earlier }] })
    expect(s.attempts?.map((a) => a.n)).toEqual([1, 2, 1, 2])
    const body = d.tracker.comments.at(-1)!.body
    expect(body).toContain('after 2 attempts')
    expect(body).toContain('- Attempt 1: checks failed (c1 failed)\n- Attempt 2: checks failed (c1 failed)\n\nLast failures:')
  })

  it("goes on to the next attempt when a no-change answer on an earlier attempt's commit fails verification", async () => {
    const d = setup(); d.workspace.commitResults = ['sha3', null, 'sha4']
    d.agent.script.revise = [revised, { ...revised, noChangeNeeded: 'It is fine as it is.' }, revised]
    const failed = { passed: false, output: 'expected subtotal' }
    // Two runs for the first attempt, one strict run for the no-change answer.
    d.environment.checkResults = [failed, failed, failed]
    const rumba = makeRumba({ limits: { ...makeRumba().limits, maxFixAttempts: 3 } })
    const s = await revise(d, rumba, makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open')
    expect(s.attempts?.map((a) => a.outcome)).toEqual(['checks-failed', 'no-change', 'verified'])
    expect(s.attempts?.[1]?.note).toBe('The agent said no change was needed: It is fine as it is.')
    expect(d.environment.ups.map((u) => u.sha)).toEqual(['sha3', 'sha3', 'sha3', 'sha4'])
    expect(d.agent.calls[2]).toMatchObject({ attempt: 3, failures: [{ criterionId: 'c1', output: 'expected subtotal' }] })
  })

  it('is the step the engine runs for changes_requested', async () => {
    const d = setup()
    const s = await advanceTicket(d, makeRumba(), makeTicket(), changesRequested(d))
    expect(s.state).toBe('pr_open'); expect(d.codeHost.pushed).toHaveLength(1)
  })
})
