import type { RumbaConfig } from '../../config/load.js'
import { inertTitle } from './build.js'
import type { Deps } from '../../ports/deps.js'
import { hasUnverified, renderPullRequestBody } from '../evidence.js'
import { outsideScope } from '../guards.js'
import { transition } from '../states.js'
import type { Ticket, TicketState } from '../types.js'

export async function openPullRequest(deps: Deps, rumba: RumbaConfig, ticket: Ticket, state: TicketState): Promise<TicketState> {
  if (state.state !== 'verified') throw new Error(`Cannot open a pull request from state ${state.state}`)
  const { branch, baseSha } = state
  if (!branch || !baseSha) throw new Error('Cannot open a pull request without a branch and a base commit')

  const { workdir } = await deps.workspace.prepare(branch, { fresh: false })
  const changed = await deps.workspace.changedFiles(workdir, baseSha)
  // Only the files Rumba wrote its checks in are left out of the scope warning: a check moved
  // into the project's tests is judged by its new place, like any other change.
  const outside = outsideScope(changed, rumba.paths, (state.relocation?.original ?? state.checks).flatMap((c) => c.files))
  await deps.codeHost.pushBranch(workdir, branch, { force: true })

  const url = await deps.codeHost.openPullRequest({
    title: `${inertTitle(ticket.title)} (${ticket.ref})`,
    body: renderPullRequestBody({ ticket, rumba, state, outsideScope: outside, secrets: deps.secrets }),
    head: branch,
    base: await deps.codeHost.defaultBranch(),
    draft: hasUnverified(state),
  })

  // Record the pull request before commenting, so a failed comment cannot lead to a second one.
  const next = { ...transition(state, 'pr_open', deps.clock()), pullRequestUrl: url }
  await deps.tracker.writeState(ticket, next)
  await deps.tracker.comment(ticket, `Rumba opened a pull request: ${url}`)
  return next
}
