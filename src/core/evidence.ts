import type { RumbaConfig } from '../config/load.js'
import { cleanOutput, MAX_OUTPUT } from './redact.js'
import type { Check, CheckResult, Criterion, Relocation, Ticket, TicketState } from './types.js'

export interface EvidenceInput {
  ticket: Ticket
  rumba: RumbaConfig
  state: TicketState
  outsideScope: string[]
  secrets: string[]
}

/** Criteria that nothing checked: marked not checkable, or checkable without a check. */
function unverified(state: TicketState): Criterion[] {
  const checked = new Set(state.checks.map((c) => c.criterionId))
  return state.criteria.filter((c) => !c.checkable || !checked.has(c.id))
}

export function hasUnverified(state: TicketState): boolean {
  return unverified(state).length > 0
}

/** Ticket text must not break a table row. */
function cell(text: string): string {
  return text.replace(/\r?\n|\r/g, ' ').replace(/\|/g, '\\|')
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
}

function codeSpan(text: string): string {
  const flat = cell(text)
  const ticks = '`'.repeat(longestBacktickRun(flat) + 1)
  return ticks.length > 1 ? `${ticks} ${flat} ${ticks}` : `${ticks}${flat}${ticks}`
}

function block(text: string): string {
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
  return `${fence}\n${text}\n${fence}`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The check's files; for a relocated check, also where each came from. */
function fileCell(check: Check, relocation: Relocation | undefined): string {
  const original = relocation?.original?.find((c) => c.criterionId === check.criterionId)
  const files = check.files.map((f) => {
    const from = (relocation?.moves ?? []).filter((m) => m.to === f && original?.files.includes(m.from)).map((m) => codeSpan(m.from))
    return from.length > 0 ? `${codeSpan(f)} (relocated from ${from.join(', ')})` : codeSpan(f)
  }).join(', ')
  return check.changedAfterReview === true ? `${files} (changed after review)` : files
}

function verdict(results: CheckResult[] | undefined, criterionId: string): string {
  const r = results?.find((x) => x.criterionId === criterionId)
  return r === undefined ? '-' : r.passed ? 'pass' : 'fail'
}

/** Well under GitHub's 65,536-character limit on a pull request body. */
export const MAX_PULL_REQUEST_BODY = 60000
/** Below this, check output is left out rather than cut further. */
const MIN_OUTPUT_CAP = 100
const OUTPUT_LEFT_OUT = 'The check output was left out: the pull request body was too long.'

/**
 * The pull request body, at most MAX_PULL_REQUEST_BODY characters where cutting the check
 * output can get it there: each output's cap is halved until it fits, and below
 * MIN_OUTPUT_CAP the outputs are left out with a note.
 */
export function renderPullRequestBody(i: EvidenceInput): string {
  let cap = MAX_OUTPUT
  let body = render(i, cap)
  while (body.length > MAX_PULL_REQUEST_BODY) {
    cap = Math.floor(cap / 2)
    if (cap < MIN_OUTPUT_CAP) return render(i, null)
    body = render(i, cap)
  }
  return body
}

/** `cap`: the most characters kept of each check output; null leaves the outputs out. */
function render(i: EvidenceInput, cap: number | null): string {
  const { ticket, rumba, state } = i
  const sections: string[] = []

  if (state.fixSummary) {
    // The agent wrote it. It is quoted, and made inert: @-mentions are broken so nobody is
    // notified, issue references and issue links so the merge closes no other issue, and
    // images so the body loads nothing.
    const inert = escapeHtml(state.fixSummary.trim())
      .replace(/@(?=\w)/g, '@\u200b')
      .replace(/#(?=\d)/g, '#\u200b')
      .replace(/\/(issues|pull)\//gi, '/$1\u200b/')
      .replace(/!\[/g, '!\u200b[')
    const quoted = inert.split('\n').map((l) => `> ${l}`).join('\n')
    sections.push(`## Summary\n\n${quoted}`)
  }
  // A GitHub issue of this repository is closed by the merge; a Linear issue is linked.
  const closes = rumba.tracker.kind === 'github' && /^#\d+$/.test(ticket.ref) ? `\n\nCloses ${ticket.ref}` : ''
  sections.push(`## Ticket\n\n${ticket.url}${closes}\n\nRumba: ${rumba.name}`)

  const relocation = state.relocation?.status === 'relocated' ? state.relocation : undefined
  const rows = state.checks.flatMap((check) => {
    const criterion = state.criteria.find((c) => c.id === check.criterionId)
    if (!criterion) return []
    return [`| ${cell(criterion.text)} | ${codeSpan(check.command)} | ${fileCell(check, relocation)} | ${verdict(state.before, check.criterionId)} | ${verdict(state.after, check.criterionId)} |`]
  })
  sections.push(['## Evidence', '', '| Criterion | Check | File | Before | After |', '| --- | --- | --- | --- | --- |', ...rows].join('\n'))

  if (state.relocation?.status === 'relocated') {
    const moves = (state.relocation.moves ?? []).map((m) => `- ${codeSpan(m.from)} → ${codeSpan(m.to)}`)
    sections.push([
      '## Checks', '',
      "Rumba wrote its checks in files of its own, and moved them into the project's tests once the change passed:", '',
      ...moves, '',
      'Rumba kept the move only because it could show that the move weakened no check:', '',
      '- It compared the moved checks with the ones it verified, line by line. Only their place, their imports, their test titles and their indentation changed. Every other line is as it was, in the same order, and no line was added.',
      "- Each moved check fails on the base commit and passes on the change, run again in the project's environment.", '',
      'In the table, Before is the check as Rumba wrote it, on the base commit, and After is the moved check, on the change.',
    ].join('\n'))
  } else if (state.relocation?.status === 'rejected') {
    sections.push([
      '## Checks', '',
      "Rumba tried to move its checks into the project's tests. It rejected the attempt and put the branch back on the verified change, for this reason:", '',
      block(state.relocation.reason ?? 'no reason was recorded'), '',
      'The checks in this pull request are as Rumba wrote them, in files of their own, and the results are theirs.',
    ].join('\n'))
  }

  const open = unverified(state)
  if (open.length > 0) {
    const line = (c: Criterion) => `- ${cell(c.text)}${!c.checkable && c.reason ? ` (not checkable: ${cell(c.reason)})` : ''}`
    sections.push(`## Not verified\n\nNo check covers these criteria. A person needs to confirm them.\n\n${open.map(line).join('\n')}`)
  }

  if (i.outsideScope.length > 0) {
    sections.push(`## Outside this rumba's scope\n\nThese files changed outside the paths of this rumba.\n\n${i.outsideScope.map((f) => `- ${codeSpan(f)}`).join('\n')}`)
  }

  if (cap === null) {
    sections.push(`## Check output\n\n${OUTPUT_LEFT_OUT}`)
  } else {
    const outputs = state.checks.map((check) => {
      const part = (label: string, results: CheckResult[] | undefined) => {
        const r = results?.find((x) => x.criterionId === check.criterionId)
        return `${label}:\n\n${block(cleanOutput(r?.output ?? '', i.secrets, cap))}`
      }
      const before = relocation ? 'Before (the check as Rumba wrote it, on the base commit)' : 'Before'
      return `<details>\n<summary>${escapeHtml(check.criterionId)}: ${escapeHtml(check.command)}</summary>\n\n${part(before, state.before)}\n\n${part('After', state.after)}\n\n</details>`
    })
    sections.push(['## Check output', ...outputs].join('\n\n'))
  }

  sections.push(`## How this was produced\n\n- Environment: ${rumba.environment.kind}\n- Agent: ${rumba.agent.kind}\n- Model: ${rumba.agent.model ?? 'default'}`)

  return `${sections.join('\n\n')}\n`
}
