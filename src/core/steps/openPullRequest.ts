import type { RumbaConfig } from '../../config/load.js'
import { inertTitle } from './build.js'
import type { Deps } from '../../ports/deps.js'
import { hasUnverified, renderPullRequestBody } from '../evidence.js'
import { outsideScope } from '../guards.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'

/** The files the branch in `workdir` changed outside the rumba's paths, for the pull request body. */
export async function outsideScopeOf(deps: Deps, rumba: RumbaConfig, state: TicketState, workdir: string): Promise<string[]> {
  const changed = await deps.workspace.changedFiles(workdir, state.baseSha!)
  // Only the files Rumba wrote its checks in are left out of the scope warning: a check moved
  // into the project's tests is judged by its new place, like any other change.
  return outsideScope(changed, rumba.paths, (state.relocation?.original ?? state.checks).flatMap((c) => c.files))
}

export async function openPullRequest(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'verified') throw new Error(`Cannot open a pull request from state ${state.state}`)
  const { branch, baseSha } = state
  if (!branch || !baseSha) throw new Error('Cannot open a pull request without a branch and a base commit')

  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  const outside = await outsideScopeOf(deps, rumba, state, workdir)
  await deps.codeHost.pushBranch(workdir, branch, { force: true })
  const pushedAt = deps.clock()

  const url = await deps.codeHost.openPullRequest({
    title: `${inertTitle(ticket.title)} (${ticket.ref})`,
    body: renderPullRequestBody({ ticket, rumba, state, outsideScope: outside, secrets: deps.secrets }),
    head: branch,
    base: await deps.codeHost.defaultBranch(),
    draft: hasUnverified(state),
  })

  // Record the pull request before commenting, so a failed comment cannot lead to a second one.
  const next = { ...transition(state, 'pr_open', deps.clock()), pullRequestUrl: url, pushedAt: pushedAt.toISOString() }
  await deps.tracker.writeState(ticket, next)
  await deps.tracker.comment(ticket, `Rumba opened a pull request: ${url}`)
  return next
}
