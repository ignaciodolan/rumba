import { describe, expect, it } from 'vitest'
import { appendLesson, cleanLesson, learn, lessonEntry, LESSONS_KEPT, withLesson } from '../../src/core/lessons.js'
import { newState } from '../../src/core/states.js'
import type { Feedback, LessonRecord } from '../../src/core/types.js'
import { AgentError } from '../../src/ports/agent.js'
import { aliceReview, changesRequested, makeDeps, makeRumba, makeTicket, REVIEWED_PR } from '../../src/testing/fakes.js'

const FILE = '.rumba/shop/lessons.md'
const QUOTED = 'Please round the order total to cents in the service, never in the template that renders it.'
const review: Feedback = { ...aliceReview, text: QUOTED }
const RULE = ['Totals are rounded to cents in src/orders/total.ts; round there, not in the view.']

describe('cleanLesson', () => {
  it('keeps clean lines as they are', () => {
    expect(cleanLesson(RULE, [review], [])).toEqual({ lines: RULE })
  })
  it('redacts the secrets of the run', () => {
    expect(cleanLesson(['Never log the order token s3cr3t-order-key.'], [], ['s3cr3t-order-key']))
      .toEqual({ lines: ['Never log the order token [redacted].'] })
  })
  it('replaces control characters and newlines with spaces, and trims', () => {
    expect(cleanLesson(['  Round totals\nin cents\t\u0007here\u2028too\r '], [], []))
      .toEqual({ lines: ['Round totals in cents  here too'] })
  })
  it('drops empty lines and keeps at most three', () => {
    expect(cleanLesson(['', ' \n ', 'one', 'two', 'three', 'four'], [], [])).toEqual({ lines: ['one', 'two', 'three'] })
  })
  it('cuts each line to 200 characters', () => {
    const out = cleanLesson(['o'.repeat(250)], [], [])
    expect(out).toEqual({ lines: ['o'.repeat(200)] })
  })
  it('refuses a lesson with nothing left once cleaned', () => {
    expect(cleanLesson(['', '\n\t'], [], [])).toEqual({ refused: 'the lesson was empty once cleaned' })
  })
  it('refuses a lesson that holds 40 characters of a feedback text, whatever the case and spacing', () => {
    const lesson = ['Remember: ROUND THE ORDER   total to cents in the\tservice, as asked.']
    expect(cleanLesson(lesson, [review], [])).toEqual({ refused: 'the lesson quoted the feedback' })
  })
  it('refuses a quote split across lines', () => {
    expect(cleanLesson(['round the order total to cents', 'in the service, never in the template'], [review], []))
      .toEqual({ refused: 'the lesson quoted the feedback' })
  })
  it('refuses a quote of any of the feedback texts', () => {
    const other: Feedback = { ...aliceReview, url: `${REVIEWED_PR}#issuecomment-9`, text: 'Thanks.' }
    expect(cleanLesson([`So: ${QUOTED.slice(10, 52)}`], [other, review], [])).toEqual({ refused: 'the lesson quoted the feedback' })
  })
  it('accepts a shared run of 39 characters', () => {
    const run = QUOTED.slice(7, 46)
    expect(run).toHaveLength(39)
    expect(cleanLesson([`Note:${run}!`], [review], [])).toEqual({ lines: [`Note:${run}!`] })
  })
  it('compares with the feedback as cleaned, so a quote around a redacted secret is caught', () => {
    const secret = 'k'.repeat(45)
    const withSecret: Feedback = { ...review, text: `Use the ${secret} key only in totals.ts` }
    expect(cleanLesson([`Use the ${secret} key only in totals.ts`], [withSecret], [secret]))
      .toEqual({ refused: 'the lesson quoted the feedback' })
  })
})

describe('cleanLesson keeps lessons.md valid UTF-8 text', () => {
  const wellFormed = (out: ReturnType<typeof cleanLesson>) => 'lines' in out && out.lines.every((l) => !/\p{Cs}|\uFFFD/u.test(l))

  it('cuts at 200 code points, never inside an emoji', () => {
    const out = cleanLesson([`${'a'.repeat(199)}\u{1F600}\u{1F600}b`], [], [])
    expect(out).toEqual({ lines: [`${'a'.repeat(199)}\u{1F600}`] })
    expect(wellFormed(out)).toBe(true)
  })
  it('removes a lone surrogate', () => {
    expect(cleanLesson(['Round\uD800 totals\uDC00 in cents'], [], [])).toEqual({ lines: ['Round totals in cents'] })
  })
  it('removes the replacement character', () => {
    expect(cleanLesson(['Round\uFFFD totals'], [], [])).toEqual({ lines: ['Round totals'] })
  })
})

describe('cleanLesson removes invisible characters', () => {
  it('removes bidi and other format characters', () => {
    expect(cleanLesson(['Round \u202Etotals\u202C in cents \u2066here\u2069\u200B\uFEFF.'], [], []))
      .toEqual({ lines: ['Round totals in cents here.'] })
  })
  it('refuses a quote split by zero-width characters', () => {
    const split = QUOTED.split('').join('\u200B')
    expect(cleanLesson([split], [review], [])).toEqual({ refused: 'the lesson quoted the feedback' })
  })
  it('refuses a quote written in compatibility forms', () => {
    // Fullwidth letters fold to plain ones under NFKC.
    const wide = 'ROUND THE ORDER TOTAL'.replace(/[A-Z]/g, (c) => String.fromCodePoint(c.codePointAt(0)! + 0xFEE0))
    expect(cleanLesson([`${wide} to cents in the service, never`], [review], [])).toEqual({ refused: 'the lesson quoted the feedback' })
  })
})

describe('cleanLesson keeps each line plain text', () => {
  it.each([
    ['a heading', '# Rules: round in the service', 'Rules: round in the service'],
    ['a run of headings and quotes', '>> ## > Round in the service', 'Round in the service'],
    ['a code fence', '```js round in the service', 'js round in the service'],
    ['a longer fence inside the line', 'Round ```` in the service', 'Round  in the service'],
    ['a comment', '<!-- Round in the service -->', 'Round in the service'],
    ['a comment hidden in a comment', 'Round <!<!---->-- in the service', 'Round  in the service'],
  ])('strips %s', (_n, line, want) => {
    expect(cleanLesson([line], [], [])).toEqual({ lines: [want] })
  })
  it('keeps single backticks, a # inside the line and a lone >', () => {
    const line = 'Round in `src/orders/total.ts` (see #42); totals > 0.'
    expect(cleanLesson([line], [], [])).toEqual({ lines: [line] })
  })
  it('drops a line that was only structure', () => {
    expect(cleanLesson(['###', '```', 'Round in the service.'], [], [])).toEqual({ lines: ['Round in the service.'] })
  })
})

describe('cleanLesson redacts the line as cleaned', () => {
  it('catches a secret with a space that a newline split', () => {
    expect(cleanLesson(['Never log order\nkey 42 anywhere.'], [], ['order key 42'])).toEqual({ lines: ['Never log [redacted] anywhere.'] })
  })
  it('catches a secret split by a zero-width character', () => {
    expect(cleanLesson(['Never log s3cr3t\u200B-order-key.'], [], ['s3cr3t-order-key'])).toEqual({ lines: ['Never log [redacted].'] })
  })
})

describe('lessonEntry and appendLesson', () => {
  const entry = lessonEntry(['Round totals in the service.', 'Not in the view.'], 'https://example.test/pr/1')

  it('writes the lines as one list item linking to the pull request', () => {
    expect(entry).toBe('- Round totals in the service.\n  Not in the view.\n  From https://example.test/pr/1')
  })
  it('creates the file when it is missing or empty', () => {
    expect(appendLesson(null, entry)).toBe(`${entry}\n`)
    expect(appendLesson('\n \n', entry)).toBe(`${entry}\n`)
  })
  it.each([
    ['ends with a newline', '# Lessons\n'],
    ['ends without one', '# Lessons'],
    ['ends with blank lines', '# Lessons\n\n  \n\n'],
  ])('puts exactly one blank line before the entry when the file %s', (_n, current) => {
    expect(appendLesson(current, entry)).toBe(`# Lessons\n\n${entry}\n`)
  })
  it('leaves the existing lessons as they are', () => {
    const current = '- Earlier lesson.  \n  From https://example.test/pr/0\n'
    expect(appendLesson(current, entry)).toBe(`${current}\n${entry}\n`)
  })
})

describe('withLesson', () => {
  it(`keeps the latest ${LESSONS_KEPT}`, () => {
    let s = newState('shop', new Date('2026-01-01T00:00:00Z'))
    for (let i = 0; i < 12; i++) s = withLesson(s, { at: `t${i}`, status: 'none', reason: `r${i}` })
    expect(s.lessons).toHaveLength(LESSONS_KEPT)
    expect(s.lessons![0]!.at).toBe('t2')
    expect(s.lessons!.at(-1)!.at).toBe('t11')
  })
})

describe('learn', () => {
  const AT = '2026-01-01T00:00:00.000Z'
  const BRANCH = 'rumba/shop/123'

  function setup(result: unknown = { kind: 'distill-lesson', lesson: RULE }) {
    const d = makeDeps()
    const state = changesRequested(d, [review])
    d.agent.script['distill-lesson'] = result as never
    return { d, state, rumba: makeRumba({ context: 'Shop context.' }), ticket: makeTicket() }
  }
  const opts = { feedback: [review], url: REVIEWED_PR, branch: BRANCH, push: { force: false } }

  it('asks the agent in a discarded checkout of the default branch, then commits and pushes the lesson on the branch', async () => {
    const { d, state, rumba, ticket } = setup()
    d.workspace.files = { sha2: { [FILE]: '- Earlier lesson.\n  From https://example.test/pr/0\n' } }

    const record = await learn(d, rumba, ticket, state, opts)

    expect(record).toEqual({ at: AT, status: 'added', commit: 'file1' })
    const task = d.agent.calls[0]!
    expect(task).toMatchObject({ kind: 'distill-lesson', ticket, context: 'Shop context.', environmentKind: 'docker', feedback: [review] })
    expect(d.agent.workdirs[0]).toBe('/fake/1/rumba/shop/distill-123')
    expect(d.workspace.fileCommits).toEqual([{
      workdir: `/fake/2/${BRANCH}`,
      path: FILE,
      content: `- Earlier lesson.\n  From https://example.test/pr/0\n\n- ${RULE[0]}\n  From ${REVIEWED_PR}\n`,
      message: 'docs: lesson from review of #123',
    }])
    expect(d.codeHost.pushed).toEqual([{ branch: BRANCH, force: false }])
    expect(d.workspace.log).toEqual([
      'prepare rumba/shop/distill-123 fresh /fake/1/rumba/shop/distill-123',
      'cleanup /fake/1/rumba/shop/distill-123',
      `prepare ${BRANCH} existing /fake/2/${BRANCH}`,
      `commitFile /fake/2/${BRANCH} ${FILE}`,
      `cleanup /fake/2/${BRANCH}`,
    ])
  })

  it('creates the file when the branch has none, and can make the branch fresh and force the push', async () => {
    const { d, state, rumba, ticket } = setup()
    const record = await learn(d, rumba, ticket, state, { ...opts, branch: 'rumba/shop/lesson-123', fresh: true, push: { force: true } })

    expect(record.status).toBe('added')
    expect(d.workspace.log).toContain('prepare rumba/shop/lesson-123 fresh /fake/2/rumba/shop/lesson-123')
    expect(d.workspace.fileCommits[0]!.content).toBe(`- ${RULE[0]}\n  From ${REVIEWED_PR}\n`)
    expect(d.codeHost.pushed).toEqual([{ branch: 'rumba/shop/lesson-123', force: true }])
  })

  it('records why there is no rule, and writes nothing', async () => {
    const { d, state, rumba, ticket } = setup({ kind: 'distill-lesson', none: 'The feedback only concerns this change.' })
    expect(await learn(d, rumba, ticket, state, opts)).toEqual({ at: AT, status: 'none', reason: 'The feedback only concerns this change.' })
    expect(d.workspace.fileCommits).toEqual([])
    expect(d.codeHost.pushed).toEqual([])
    expect(d.workspace.log.filter((l) => l.startsWith('prepare'))).toHaveLength(1)
  })

  it('asks no agent without feedback', async () => {
    const { d, state, rumba, ticket } = setup()
    expect(await learn(d, rumba, ticket, state, { ...opts, feedback: [] })).toEqual({ at: AT, status: 'none', reason: 'There was no feedback to learn from.' })
    expect(d.agent.calls).toEqual([])
    expect(d.workspace.log).toEqual([])
  })

  it('refuses a lesson that quotes the feedback, and writes nothing', async () => {
    const { d, state, rumba, ticket } = setup({ kind: 'distill-lesson', lesson: [QUOTED] })
    expect(await learn(d, rumba, ticket, state, opts)).toEqual({ at: AT, status: 'refused', reason: 'the lesson quoted the feedback' })
    expect(d.workspace.fileCommits).toEqual([])
    expect(d.codeHost.pushed).toEqual([])
  })

  it('writes the lesson as cleaned', async () => {
    const { d, state, rumba, ticket } = setup({ kind: 'distill-lesson', lesson: ['Keep the token s3cr3t-order-key\nout of logs.'] })
    d.secrets = ['s3cr3t-order-key']
    await learn(d, rumba, ticket, state, opts)
    expect(d.workspace.fileCommits[0]!.content).toBe(`- Keep the token [redacted] out of logs.\n  From ${REVIEWED_PR}\n`)
  })

  it('records an agent failure with a cleaned reason, and still removes the checkout', async () => {
    const { d, state, rumba, ticket } = setup(new AgentError("The reviewers' feedback does not fit in the prompt: s3cr3t-order-key"))
    d.secrets = ['s3cr3t-order-key']
    const record = await learn(d, rumba, ticket, state, opts)
    expect(record).toEqual({ at: AT, status: 'failed', reason: "The lesson could not be drawn: The reviewers' feedback does not fit in the prompt: [redacted]" })
    expect(d.workspace.log).toEqual(['prepare rumba/shop/distill-123 fresh /fake/1/rumba/shop/distill-123', 'cleanup /fake/1/rumba/shop/distill-123'])
  })

  it('fails on a result of another kind', async () => {
    const { d, state, rumba, ticket } = setup({ kind: 'fix', summary: 'x' })
    const record = await learn(d, rumba, ticket, state, opts)
    expect(record.status).toBe('failed')
    expect(d.workspace.fileCommits).toEqual([])
  })

  it('bounds a long reason', async () => {
    const { d, state, rumba, ticket } = setup(new Error('x'.repeat(5000)))
    const record = await learn(d, rumba, ticket, state, opts)
    expect(record.reason!.length).toBe(500)
  })

  it('records a refused commit as a failure and removes the checkout', async () => {
    const { d, state, rumba, ticket } = setup()
    d.workspace.commitFile = async () => { throw new Error('.rumba/shop is not a folder in HEAD') }
    const record = await learn(d, rumba, ticket, state, opts)
    expect(record).toEqual({ at: AT, status: 'failed', reason: 'The lesson could not be drawn: .rumba/shop is not a folder in HEAD' })
    expect(d.codeHost.pushed).toEqual([])
    expect(d.workspace.log.at(-1)).toBe(`cleanup /fake/2/${BRANCH}`)
  })

  it('records a refused push as a failure and takes the lesson commit off the local branch', async () => {
    const { d, state, rumba, ticket } = setup()
    d.codeHost.pushBranch = async () => { throw new Error('rejected: non-fast-forward') }
    const record: LessonRecord = await learn(d, rumba, ticket, state, opts)
    expect(record).toEqual({ at: AT, status: 'failed', reason: 'The lesson could not be drawn: rejected: non-fast-forward' })
    expect(d.workspace.branchTip).toBe('sha2')
    expect(d.workspace.log.slice(-2)).toEqual([`reset /fake/2/${BRANCH} sha2`, `cleanup /fake/2/${BRANCH}`])
  })
})
