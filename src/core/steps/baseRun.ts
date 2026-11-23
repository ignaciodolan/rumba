import type { Deps } from '../../ports/deps.js'
import type { EnvHandle } from '../../ports/environment.js'
import { timeLeft } from '../budget.js'
import { checkOutputMax, cleanOutput } from '../redact.js'
import type { Check, CheckResult, TicketState } from '../types.js'
import { COULD_NOT_RUN } from './build.js'
import { cleanupQuietly, downQuietly } from './teardown.js'

/** Checks whose files changed after Rumba verified them, to run on the base commit. */
export interface BaseRun {
  /** The scratch branch the base commit is made on, never pushed by Rumba. */
  branch: string
  /** The commit that holds the checks as they are now. */
  sha: string
  checks: Check[]
  /** The files set to their content in `sha`; a file `sha` does not have is removed. */
  files: string[]
  /** How the checks are named in a refusal: "relocated", "changed". */
  what: string
  /** The message of the base commit. */
  message: string
  /** The folder the agent wrote in, which a run must never use. */
  agentDir?: string
  /** The checks must keep their files: each is hashed, and a check that lost one is refused before anything runs. */
  keepFiles?: boolean
}

/** Why a check was refused on the base commit, and which one. */
export interface Refused { criterionId: string; reason: string }

/**
 * On the base commit with the checks as they are now, every check fails. The commit is the
 * checks commit, which the checks Rumba wrote failed on, with `files` set to their content in
 * `sha`, on a scratch branch that starts where the fix branch did. Rumba never pushes it; a
 * vercel-preview environment pushes it as a throwaway branch and deletes it. A check that
 * passes there, cannot run there or dies of the machine there is refused, with the reason.
 * With `keepFiles`, `hashes` are those of `files` in that checkout, before anything runs.
 */
export async function onTheBase(deps: Deps, state: TicketState, run: BaseRun): Promise<{ results: CheckResult[]; hashes: Record<string, string> } | Refused> {
  const { workdir } = await deps.workspace.prepare(run.branch, { fresh: true, like: state.branch! })
  try {
    if (run.agentDir !== undefined) notWhereTheAgentWrote(workdir, run.agentDir)
    await deps.workspace.reset(workdir, state.checksSha!)
    await deps.workspace.checkoutFiles(workdir, run.sha, run.files)
    const base = await deps.workspace.commit(workdir, run.message, { allowEmpty: true })
    if (base === null) throw new Error(`The workspace made no commit of the ${run.what} checks on the base commit.`)
    const hashes = run.keepFiles === true ? await deps.workspace.hashFiles(workdir, run.files) : {}
    if (run.keepFiles === true) {
      for (const check of run.checks) {
        const lost = check.files.find((f) => hashes[f] === undefined)
        if (lost !== undefined) return { criterionId: check.criterionId, reason: `The ${run.what} check for ${check.criterionId} lost its file ${lost}: a check may change, but not lose its files.` }
      }
    }
    const handle = await deps.environment.up({ branch: run.branch, sha: base, role: 'before', timeoutMs: timeLeft(deps) }, workdir)
    try {
      const results = await runChecks(deps, handle, run.checks)
      for (const { criterionId, infrastructure, exitCode, passed } of results) {
        if (infrastructure) return { criterionId, reason: `The ${run.what} check for ${criterionId} could not be judged on the base commit: ${infrastructure}.` }
        if (COULD_NOT_RUN.includes(exitCode)) return { criterionId, reason: `The ${run.what} check for ${criterionId} could not run on the base commit (exit ${exitCode}).` }
        if (passed) return { criterionId, reason: `The ${run.what} check for ${criterionId} passes on the base commit, so it no longer shows the problem.` }
      }
      return { results, hashes }
    } finally {
      await downQuietly(deps.environment, handle)
    }
  } finally {
    await cleanupQuietly(deps.workspace, workdir)
  }
}

/** A checkout that would run where the agent wrote (its folder could not be removed, say) is refused. */
export function notWhereTheAgentWrote(workdir: string, agentDir: string): void {
  if (workdir === agentDir) throw new Error('The checkout for the run is the folder the agent wrote in, which was not removed.')
}

export async function runChecks(deps: Deps, handle: EnvHandle, checks: Check[]): Promise<CheckResult[]> {
  const max = checkOutputMax(checks.length)
  const results: CheckResult[] = []
  for (const check of checks) {
    const r = await deps.environment.runCheck(handle, check)
    results.push({ ...r, output: cleanOutput(r.output, deps.secrets, max) })
  }
  return results
}
