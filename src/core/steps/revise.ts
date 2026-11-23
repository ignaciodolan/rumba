import type { RumbaConfig } from '../../config/load.js'
import type { AgentResult } from '../../ports/agent.js'
import type { Deps } from '../../ports/deps.js'
import { InfrastructureError } from '../../ports/environment.js'
import { timeLeft } from '../budget.js'
import { inertText, renderPullRequestBody } from '../evidence.js'
import { cleanOutput, redact } from '../redact.js'
import { transition } from '../states.js'
import type { AttemptRecord, Feedback, Ticket, TicketState } from '../types.js'
import {
  ATTEMPT_TAIL, brief, describe, execPrefixOf, type Failure, inertTitle, type Lock, protectedFailure, type Verdict, verify, verifyOnce,
} from './build.js'
import { outsideScopeOf } from './openPullRequest.js'
import { cleanupQuietly } from './teardown.js'

type Revised = Extract<AgentResult, { kind: 'revise' }>

/** The most characters of the change so far that the agent is given. */
const MAX_DIFF = 30000
/** The most characters of each reply of the agent posted on the pull request. */
const MAX_REPLY = 500
const MAX_REASON = 2000
const MAX_SUMMARY = 2000
/** At most this many attempts are kept on the ticket, the latest, as in building. */
const MAX_ATTEMPTS_KEPT = 10
const NO_REPLY = 'No reply from the agent.'

/** One review round in progress: where the branch stood when it started, and the attempts so far. */
interface Round {
  deps: Deps
  rumba: RumbaConfig
  ticket: Ticket
  current: TicketState
  /** Which round this is, from 1. */
  n: number
  /** When the round started: the feedback it answers is what was written before then. */
  startedAt: string
  /** The pull request's head when the round started. */
  start: string
  lock: Lock
  feedback: Feedback[]
  attempts: AttemptRecord[]
}

/** How one attempt ended, before its verification. */
type Tried = { result: Revised; tip: string } & ({ sha: string } | { failures: Failure[] } | { noChange: string })

/** What the attempts of a round came to. */
type Outcome =
  | { kind: 'passed'; result: Revised; results: Extract<Verdict, { kind: 'passed' }>['results'] }
  | { kind: 'no-change'; result: Revised; reason: string }
  | { kind: 'failed'; failures: Failure[] }

/**
 * One review round on the ticket's pull request: the agent revises the change on the same
 * branch, Rumba verifies it as in building, pushes it to the same pull request and replies
 * there. A round that fails every attempt goes to a person, with the branch as it was.
 */
export async function revise(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'changes_requested') throw new Error(`Cannot revise from state ${state.state}`)
  const { branch, baseSha, pullRequestUrl: url } = state
  if (!branch || !baseSha || !url) throw new Error('Cannot revise without a branch, a base commit and a pull request')

  const max = rumba.limits.maxReviewRounds
  const done = state.reviewRounds ?? 0
  if (done >= max) {
    await deps.tracker.comment(ticket, `Rumba stopped revising this pull request: it already ran ${max} review rounds, the most allowed. A person needs to take it from here: ${url}`)
    const next = transition(state, 'needs_human', deps.clock(), 'review round limit')
    await deps.tracker.writeState(ticket, next)
    return next
  }

  // The checks as they stand now (after a relocation, the moved files) are locked for the round.
  const files = [...new Set(state.checks.flatMap((c) => c.files))]
  const { start, hashes } = await atPullRequestHead(deps, branch, url, files)
  const n = done + 1
  const r: Round = {
    deps, rumba, ticket, n, start, startedAt: deps.clock().toISOString(), lock: { files, hashes, resetTo: start }, feedback: state.feedback ?? [], attempts: [],
    current: { ...transition(state, 'building', deps.clock(), `review round ${n}`), reviewRounds: n, checkHashes: hashes },
  }
  // Counted and written before the agent runs, so a round that dies still counts.
  await deps.tracker.writeState(ticket, r.current)

  let outcome: Outcome
  try {
    outcome = await attempts(r)
  } catch (e) {
    // Nothing of a round that died stays on the branch: the next round starts where this one did.
    await resetQuietly(deps, branch, start)
    throw e
  }
  if (outcome.kind === 'passed') return succeed(r, outcome)
  if (outcome.kind === 'no-change') return answerWithoutChange(r, outcome)
  return fail(r, outcome.failures)
}

/**
 * Puts the branch at the pull request's head and hashes `files` there, in a new checkout. A
 * person may have pushed to the branch, and their commits are kept; a commit a killed run left
 * on the local branch, never pushed, is dropped.
 */
async function atPullRequestHead(deps: Deps, branch: string, url: string, files: string[]): Promise<{ start: string; hashes: Record<string, string> }> {
  const { headSha } = await deps.codeHost.getPullRequest(url)
  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  try {
    await deps.workspace.syncToRemote(workdir, branch, headSha)
    return { start: headSha, hashes: await deps.workspace.hashFiles(workdir, files) }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/** Up to max_fix_attempts attempts, each verified as in building; the failures of one are given to the next. */
async function attempts(r: Round): Promise<Outcome> {
  const { deps, rumba } = r
  let failures: Failure[] = []
  for (let attempt = 1; attempt <= rumba.limits.maxFixAttempts; attempt++) {
    const tried = await reviseOnce(r, failures, attempt)
    if ('noChange' in tried && tried.tip === r.start) return { kind: 'no-change', result: tried.result, reason: tried.noChange }

    // A no-change answer on top of an earlier attempt's commit is verified once more as the
    // code stands, strictly, as building does.
    const noted = 'noChange' in tried ? { note: cleanOutput(`The agent said no change was needed: ${tried.noChange}`, deps.secrets, MAX_REASON) } : {}
    const v: Verdict = 'noChange' in tried
      ? await verifyOnce(deps, rumba, r.current, tried.tip, r.lock)
      : 'sha' in tried ? await verify(deps, rumba, r.current, tried.sha, r.lock) : { kind: 'guard', failures: tried.failures }

    if (v.kind === 'infrastructure') {
      await record(r, { outcome: 'infrastructure', checks: brief(v.results), projectTests: v.projectTests, ...noted, tail: v.tail })
      throw new InfrastructureError(v.reason)
    }
    if (v.kind === 'passed') {
      await record(r, { outcome: 'verified', checks: brief(v.results), projectTests: v.projectTests, ...noted, tail: '' })
      return { kind: 'passed', result: tried.result, results: v.results }
    }
    if (v.kind === 'guard') {
      await record(r, { outcome: 'guard', checks: [], projectTests: 'not-run', note: cleanOutput(v.failures[0]?.output ?? '', deps.secrets, ATTEMPT_TAIL), tail: '' })
    } else {
      await record(r, { outcome: 'noChange' in tried ? 'no-change' : v.kind, checks: brief(v.results), projectTests: v.projectTests, ...noted, tail: v.tail })
    }
    failures = v.failures
  }
  return { kind: 'failed', failures }
}

async function record(r: Round, a: Omit<AttemptRecord, 'n'>): Promise<void> {
  // Numbered within the round, so the round's comment counts its own attempts.
  const attempt = { n: r.attempts.length + 1, ...a }
  r.attempts.push(attempt)
  r.current = { ...r.current, attempts: [...(r.current.attempts ?? []), attempt].slice(-MAX_ATTEMPTS_KEPT) }
  await r.deps.tracker.writeState(r.ticket, r.current)
}

/**
 * One attempt in a new worktree of the branch: the agent revises the code, Rumba commits and
 * guards the commit, and the worktree is removed. A rejected commit is reset to the round's start.
 */
async function reviseOnce(r: Round, failures: Failure[], attempt: number): Promise<Tried> {
  const { deps, rumba, ticket, current } = r
  const { workdir } = await deps.workspace.prepare(current.branch!, { fresh: false })
  try {
    // The agent's sandbox cannot run git, so it is given the change so far.
    const diff = await deps.workspace.diff(workdir, current.baseSha!, MAX_DIFF)
    const result = await deps.agent.run({
      kind: 'revise', ticket, context: rumba.context, environmentKind: rumba.environment.kind, timeoutMs: timeLeft(deps), ...execPrefixOf(rumba),
      criteria: current.criteria, checks: current.checks, feedback: r.feedback, diff, lockedFiles: r.lock.files, failures, attempt,
    }, workdir)
    if (result.kind !== 'revise') throw new Error(`Agent returned ${result.kind} for a revise task`)

    const sha = await deps.workspace.commit(workdir, `fix: ${inertTitle(ticket.title)} (${ticket.ref}), after review`)
    if (sha === null) {
      const tip = await deps.workspace.head(workdir)
      if (result.noChangeNeeded !== undefined) return { noChange: result.noChangeNeeded, result, tip }
      return { failures: [{ criterionId: 'guard', output: 'The agent changed no files.' }], result, tip }
    }
    const guard = await protectedFailure(deps, rumba, workdir, r.start) ?? await checkChangeFailure(deps, workdir, r.start, r.lock, result.checkChanges ?? [])
    if (guard !== null) {
      await deps.workspace.reset(workdir, r.start)
      return { failures: [{ criterionId: 'guard', output: guard }], result, tip: r.start }
    }
    return { sha, result, tip: sha }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/**
 * Locked check files the attempt changed since the round started. A check may change only when
 * the agent declares it and Rumba shows that the new check fails on the base and passes on the
 * change. Without that proof, a declared change is refused like an undeclared one.
 */
async function checkChangeFailure(
  deps: Deps, workdir: string, since: string, lock: Lock, _declared: NonNullable<Revised['checkChanges']>,
): Promise<string | null> {
  const changed = new Set(await deps.workspace.changedFiles(workdir, since))
  const edited = lock.files.filter((f) => changed.has(f))
  return edited.length > 0 ? `The change edited check files, which must stay as written: ${edited.join(', ')}` : null
}

/** Pushes the verified round to the same pull request, then updates its body and replies there. */
async function succeed(r: Round, outcome: Extract<Outcome, { kind: 'passed' }>): Promise<TicketState> {
  const { deps, rumba, ticket } = r
  const branch = r.current.branch!
  const url = r.current.pullRequestUrl!
  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  let outside: string[]
  try {
    outside = await outsideScopeOf(deps, rumba, r.current, workdir)
    // A fast-forward on top of the head the round started from, never a force push: a commit a
    // person pushed while the round ran makes this fail, and the next run starts from it.
    await deps.codeHost.pushBranch(workdir, branch, { force: false })
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }

  const now = deps.clock()
  const { feedback: _answered, ...rest } = r.current
  const verified = {
    ...transition(rest, 'verified', now), after: outcome.results, pushedAt: now.toISOString(), answeredAt: r.startedAt,
    fixSummary: cleanOutput(outcome.result.summary, deps.secrets, MAX_SUMMARY),
  }
  const next = transition(verified, 'pr_open', now, `review round ${r.n}`)
  // Written before the pull request calls, so a failure there cannot undo the round.
  await deps.tracker.writeState(ticket, next)
  const body = renderPullRequestBody({ ticket, rumba, state: next, outsideScope: outside, secrets: deps.secrets })
  await quietly(() => deps.codeHost.updatePullRequest(url, { body }))
  const lines = r.feedback.length === 0 ? [`Revised as asked with the ${rumba.labels.revise} label.`] : feedbackLines(r, outcome.result)
  await quietly(() => deps.codeHost.commentOnPullRequest(url, lines.join('\n')))
  return next
}

/** The agent found nothing to change: its reason and replies go on the pull request, and nothing is pushed. */
async function answerWithoutChange(r: Round, outcome: Extract<Outcome, { kind: 'no-change' }>): Promise<TicketState> {
  const { deps, ticket } = r
  const url = r.current.pullRequestUrl!
  await record(r, { outcome: 'no-change', checks: [], projectTests: 'not-run', note: cleanOutput(`The agent said no change was needed: ${outcome.reason}`, deps.secrets, MAX_REASON), tail: '' })
  const now = deps.clock()
  const { feedback: _answered, ...rest } = r.current
  // The answer deals with the feedback from before the round, though nothing was pushed.
  const next = { ...transition(transition(rest, 'verified', now, 'no change needed'), 'pr_open', now, `review round ${r.n}: no change needed`), answeredAt: r.startedAt }
  await deps.tracker.writeState(ticket, next)

  const reason = inertText(redact(outcome.reason, deps.secrets).trim().slice(0, MAX_REASON)).split('\n').map((l) => `> ${l}`).join('\n')
  const lines = feedbackLines(r, outcome.result)
  const reply = ["Rumba made no change in this round. The agent's reason:", '', reason, ...(lines.length > 0 ? ['', ...lines] : [])]
  await quietly(() => deps.codeHost.commentOnPullRequest(url, reply.join('\n')))
  return next
}

/** Every attempt failed: the branch goes back to where the round started, and a person takes over. */
async function fail(r: Round, failures: Failure[]): Promise<TicketState> {
  const { deps, ticket } = r
  await resetBranch(deps, r.current.branch!, r.start)
  const count = r.attempts.length
  const last = r.attempts.at(-1)
  const what = last?.outcome === 'project-tests-failed' ? "the project's own tests" : 'the checks'
  const after = `The branch is back where it was before this round, and nothing was pushed: ${r.current.pullRequestUrl!}`
  const headline = last?.outcome === 'guard'
    ? `Rumba could not revise the pull request after ${count} attempts: the last change was rejected. ${after}`
    : `Rumba could not revise the pull request: ${what} still fail after ${count} attempts. ${after}`
  await deps.tracker.comment(ticket, [
    headline, '',
    ...r.attempts.map((a) => `- Attempt ${a.n}: ${describe(a)}`), '',
    'Last failures:', '', failures.map((f) => `${f.criterionId}:\n${f.output}`).join('\n\n'),
  ].join('\n'))
  const next = transition(r.current, 'needs_human', deps.clock(), `review round ${r.n} failed: ${what} still fail after ${count} attempts`)
  await deps.tracker.writeState(ticket, next)
  return next
}

/**
 * One line per piece of feedback, in order, with the agent's reply to it. Everything a reviewer
 * or the agent wrote is made inert, and no author is mentioned with an @.
 */
function feedbackLines(r: Round, result: Revised): string[] {
  const secrets = r.deps.secrets
  const replies = new Map<number, string>()
  for (const { item, reply } of result.replies) if (!replies.has(item)) replies.set(item, reply)
  return r.feedback.map((f, i) => {
    const reply = replies.get(i + 1)
    const author = oneLine(f.author.replace(/^@+/, ''), secrets, 100)
    return `- ${kindOf(f, secrets)} by ${author} (${f.url.replace(/\s/g, '')}): ${reply === undefined ? NO_REPLY : oneLine(reply, secrets, MAX_REPLY)}`
  })
}

function kindOf(f: Feedback, secrets: string[]): string {
  if (f.kind === 'review') return 'Review'
  if (f.kind === 'comment') return 'Comment'
  const line = f.line === undefined ? '' : `:${Number(f.line)}`
  return `Line comment on ${oneLine(f.path ?? 'a file', secrets, 500)}${line}`
}

/** Untrusted text on one line, at most `max` characters, made inert. */
function oneLine(text: string, secrets: string[], max: number): string {
  return inertText(redact(text, secrets).replace(/\s+/g, ' ').trim().slice(0, max))
}

async function resetBranch(deps: Deps, branch: string, sha: string): Promise<void> {
  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  try {
    await deps.workspace.reset(workdir, sha)
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

async function resetQuietly(deps: Deps, branch: string, sha: string): Promise<void> {
  try {
    await resetBranch(deps, branch, sha)
  } catch {
    // The round's own error is the one to report.
  }
}

/** A failed pull request call after the round is recorded does not undo the round. */
async function quietly(call: () => Promise<void>): Promise<void> {
  try {
    await call()
  } catch {
    // The state already holds the round; only the body or the reply is lost.
  }
}
