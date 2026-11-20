import type { RumbaConfig } from '../config/load.js'
import { cleanOutput, MAX_OUTPUT } from './redact.js'
import type { CheckResult, Criterion, Ticket, TicketState } from './types.js'

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

  sections.push(`## Ticket\n\n${ticket.url}\n\nRumba: ${rumba.name}`)

  const rows = state.checks.flatMap((check) => {
    const criterion = state.criteria.find((c) => c.id === check.criterionId)
    if (!criterion) return []
    return [`| ${cell(criterion.text)} | ${codeSpan(check.command)} | ${verdict(state.before, check.criterionId)} | ${verdict(state.after, check.criterionId)} |`]
  })
  sections.push(['## Evidence', '', '| Criterion | Check | Before | After |', '| --- | --- | --- | --- |', ...rows].join('\n'))

  const open = unverified(state)
  if (open.length > 0) {
    sections.push(`## Not verified\n\nNo check covers these criteria. A person needs to confirm them.\n\n${open.map((c) => `- ${cell(c.text)}`).join('\n')}`)
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
      return `<details>\n<summary>${escapeHtml(check.criterionId)}: ${escapeHtml(check.command)}</summary>\n\n${part('Before', state.before)}\n\n${part('After', state.after)}\n\n</details>`
    })
    sections.push(['## Check output', ...outputs].join('\n\n'))
  }

  sections.push(`## How this was produced\n\n- Environment: ${rumba.environment.kind}\n- Agent: ${rumba.agent.kind}\n- Model: ${rumba.agent.model ?? 'default'}`)

  return `${sections.join('\n\n')}\n`
}
