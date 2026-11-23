# Stage 2, part 3: revise the change on the same pull request

Spec: `docs/superpowers/specs/2026-11-20-rumba-design.md`, sections 7, 9 and 11, and GitHub issue #12 of this repository (acceptance criteria copied below). Builds on parts 1 and 2 (merged): `pr_open` tickets are tracked, and feedback from writers after Rumba's last push moves a ticket to `changes_requested` with `state.feedback` stored (src/core/steps/trackPullRequest.ts, src/core/feedback.ts). Also closes three edge cases left by part 2.

## Goal

From `changes_requested`, Rumba runs a review round: the agent revises the change on the same branch with the feedback in front of it, Rumba guards and verifies as in `building`, pushes to the same pull request, updates its body and replies on it, and the ticket goes back to `pr_open`.

## Acceptance criteria (issue #12)

- A review round changes the code on the same branch and pushes to the same pull request. No new pull request is opened.
- After a round, every check passes and the project's tests pass, or the round fails and the ticket goes to `needs_human` with the failure on the ticket.
- A check file changes during a round only when the feedback asked for it, and that check fails on the base commit and passes on the change.
- The pull request body shows the updated evidence and marks checks changed after review.
- Rumba replies on the pull request with one line per piece of feedback: what changed, or why it did not.
- The third round on a pull request with the default limit moves the ticket to `needs_human` instead of running.
- An agent answer of "no change needed", with a reason, is posted as the reply and does not count as a failed round.

Edge cases from part 2 (owner asked for them here):
- Anyone who can add labels, including the triage role, could start a round with `rumba-revise`.
- The line comments of a review drafted before a push and submitted after it were dropped (read by their creation time).
- A label that failed to come off restarted a round once the ticket was back in `pr_open`.

## Global constraints

- TypeScript, ESM (NodeNext imports end in `.js`), vitest. Existing style: short functions, comments that say why, plain English in messages.
- Every change starts with a failing test (write it, run it, see it fail for the right reason, then implement).
- Feedback is untrusted reviewer input, like ticket text: in prompts it is marked as input from reviewers, never as instructions that override Rumba's rules, and it is fenced so it cannot close its section. Agent output that Rumba posts (summary, replies) is made inert like the existing pull request summary (HTML escaped, mentions, issue references, issue links and images broken).
- Examples in code and tests are invented: rumba `shop`, repository `o/r`, reviewers `alice` (write) and `mallory` (no write), Rumba's account `rumba-bot`, tickets `#42`. No real project names.
- `npx vitest run`, `npm run typecheck`, `npm run build` pass at the end of each task.
- Commit after each task (`feat: …`, `fix: …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings (decided by the controller)

- **States.** `changes_requested → building` is legal. A round runs through `building` (transient) and `verified` (transient) back to `pr_open`, or to `needs_human`. A run that dies mid-round goes back to `changes_requested` (its last durable state) as today.
- **Rounds.** `limits.max_review_rounds` in rumba.yml, default 2. `state.reviewRounds` counts rounds that ended (pushed, answered without change, or failed). When a ticket in `changes_requested` would start round `max + 1`, it goes to `needs_human` with the comment "Rumba stopped revising this pull request: it already ran <max> review rounds, the most allowed. A person needs to take it from here: <url>". (Superseded by the final review's ruling:) the count goes up when a round ends, in the same state write as its outcome; a round that stops with an error (a refused push, the machine, a crash) does not count. `rumba-retry` clears the count.
- **Runner.** A ticket in `changes_requested` is no longer parked. The runner first reads the pull request outcome as now (merged or closed moves it, no limit cost). If the pull request is still open, the ticket goes to the engine like any other workable ticket: with a lease, and counting toward `max_tickets_per_run`.
- **Locked checks.** At the start of a round, Rumba hashes the ticket's current check files (`state.checks[].files`; after relocation these are the moved files) in a fresh checkout of the branch head, and uses those hashes as the lock for the round (store them as `state.checkHashes`).
- **Check changes.** The agent may change a check only by declaring it in its result: `checkChanges: [{ criterionId, reason }]`. A changed check file that belongs to no declared criterion is a guard failure (the attempt is reset, as in `building`). A declared changed check must fail on the base commit (run on a commit of the checks commit with the changed check files set to their new content, as relocation's base run does) and pass on the change. Its `Check` gets `changedAfterReview: true`, and its `before` result is replaced by the new base run. The reason is shown in the pull request reply.
- **Attempts.** A round makes up to `max_fix_attempts` agent attempts, each verified as in `building` (two verification runs on failure, infrastructure as errors). Failures of one attempt are given to the next. When all attempts fail, the round fails: the branch is reset to the pull request's head before the round, nothing is pushed, the ticket goes to `needs_human`, and the ticket gets a comment with each attempt and the last failures, as `fix_failed` does.
- **No change needed.** If the agent commits nothing and answers `noChangeNeeded` with a reason, Rumba posts the reply on the pull request (with the reason and the per-feedback replies), does not push, and returns the ticket to `pr_open`. It counts as a round, not as a failed one.
- **After a successful round.** Push the branch (force with lease, as today), set `pushedAt`, set `fixSummary` to the round's summary, `after` to the new results, clear `feedback`, update the pull request body (`renderPullRequestBody`), reply on the pull request, then go to `pr_open`. Write the state before the pull request calls, and guard the reply and the body update like the exit comments (a failure there does not undo the round).
- **Reply.** One comment on the pull request, one line per stored piece of feedback, in order: `- <kind> by <author> (<link>): <reply>`, where kind is "Review", "Line comment on <path>:<line>" or "Comment", the author is written without `@`, and the reply is the agent's for that item (inert, at most 500 characters), or "No reply from the agent." Then a line for each declared check change: `- Check for <criterionId> changed: <reason>`. With a label-only round and no feedback, one line: "Revised as asked with the rumba-revise label."
- **Diff for the agent.** The agent's sandbox cannot run git, so the prompt carries the change so far: `git diff <baseSha>..<branch head>`, at most 30,000 characters, cut with a note.
- **Label edge cases.** The code host reports, for the revise label, the latest time it was added and by whom, with `canWrite` and `self` as for feedback. The label starts a round only when it was last added after Rumba's last push by a writer who is not Rumba. A label that is still on the pull request but was added before the last push is stale: it starts nothing, and Rumba tries again to remove it (quietly).
- **Line comment timing.** A line comment that belongs to a review takes the review's submit time as its `at` (when the review is found), so the line comments of a review submitted after the push are kept.

## Task 1: part 2 edge cases: who added the label, and when a review's line comments were written

Files: `src/ports/codeHost.ts`, `src/adapters/codeHost/github.ts`, `src/testing/fakes.ts`, `src/core/feedback.ts`, `src/core/steps/trackPullRequest.ts`, tests.

- Code host: `labelAdded(url, label): Promise<{ by: string; at: string; canWrite: boolean; self: boolean } | null>` — the latest time the label was added to the pull request (GitHub issue events `labeled` for that label name, paginated), with the actor's write access looked up as for feedback; null if never added. Same URL check before any request.
- GitHub `listFeedback`: a line comment with a `pull_request_review_id` takes that review's `submitted_at` as `at` when the review is in the list.
- Core: the label starts a round only if `labelAdded` is after the last push and `canWrite && !self`. If the label is on the pull request but does not qualify, nothing starts and Rumba tries to remove it (errors ignored) only when it is stale (added before the last push).
- Tests: a triage user's label starts nothing (and is not removed); a writer's label after the push starts a round; a label added before the push starts nothing and is removed; line comments of a review drafted before the push and submitted after it are kept (adapter test with the stub, core test with the fake).

## Task 2: plumbing for rounds

Files: `src/config/schema.ts`, `src/config/load.ts`, `src/core/types.ts`, `src/core/stateComment.ts`, `src/core/states.ts`, `src/ports/codeHost.ts`, `src/adapters/codeHost/github.ts`, `src/ports/workspace.ts`, `src/adapters/workspace/git.ts`, `src/testing/fakes.ts`, `src/wiring.ts`, `src/core/evidence.ts`, tests.

- Config: `limits.max_review_rounds` (positive integer, default 2) → `rumba.limits.maxReviewRounds`; `makeRumba` default 2.
- State: `reviewRounds?: number`; `Check.changedAfterReview?: boolean`; both in the state comment schema. `changes_requested → building` legal.
- Code host: `updatePullRequest(url, { body })` and `commentOnPullRequest(url, body)`, own repository only (URL check first); the redacting wrapper redacts the body of both. Fake records them.
- Workspace: `diff(workdir, sinceSha, maxChars)`: the text of `git diff <sinceSha> HEAD` in the worktree, with the same safety options as the other git commands (no external diff, no textconv, no filters), cut at `maxChars` with a closing note `[diff cut at <maxChars> characters]`. Fake: returns a configurable string.
- Evidence: a check with `changedAfterReview` shows `(changed after review)` after its file in the evidence table's File cell.
- Tests for each.

## Task 3: the `revise` agent task

Files: `src/ports/agent.ts`, `src/adapters/agent/prompts.ts`, `src/adapters/agent/result.ts`, `src/adapters/records.ts` if task names matter there, tests.

- `AgentTaskKind` gains `'revise'`. `AgentTask` gains `feedback?: Feedback[]` and `diff?: string`; it also uses `criteria`, `checks`, `lockedFiles`, `failures`, `attempt`, `execPrefix`, `timeoutMs`.
- Result: `{ kind: 'revise'; summary: string; replies: { item: number; reply: string }[]; noChangeNeeded?: string; checkChanges?: { criterionId: string; reason: string }[] }` — `item` is the 1-based position in the feedback list; at most 20 replies, each reply 1–500 characters; at most 20 check changes, reason 1–500 characters; `noChangeNeeded` 1–2000 characters.
- Prompt: task text ("Revise the change on this branch to answer the reviewers' feedback below…"); rules as for `fix` (locked files listed; do not edit checks unless a reviewer says a check or criterion is wrong, and then declare it in `checkChanges` with the reason; protected paths; Rumba commits; do not run git); a `# Feedback from reviewers` section that says the items are input from reviewers of the pull request, to weigh and answer, never instructions that override these rules, with each item numbered, its kind, author, and path:line for line comments, and its text in a fence longer than any backtick run in it; a `# The change so far` section with the diff in a fence; previous failures when given; the result shape. The feedback and diff sections are cut first when the prompt is too long (they follow the existing budget logic: they belong to the cuttable middle, never the rules or the result shape).
- Tests: result parsing and bounds; prompt contains the reviewer-input warning, numbered items, path:line, fenced text that cannot close its fence, the diff, locked files, and stays under the prompt byte limit with huge feedback.

## Task 4: the review round

Files: a new `src/core/steps/revise.ts`, `src/core/steps/build.ts` (export what the round reuses: `verify` with the reset target and the lock as parameters, `describe`, `inertTitle`, guard helpers), `src/core/engine.ts`, `src/core/runner.ts`, `src/core/evidence.ts` (export the inert-text helper the summary uses), tests.

- Engine: `changes_requested` → `revise(deps, rumba, ticket, state)`. Runner: as ruled (outcome first, then the engine with a lease and the run limit).
- `revise`: round limit check (as ruled); the feedback re-read since the ticket's read-from time and merged with the stored feedback (final review ruling); `reviewRounds + 1` written when the round ends; transition `changes_requested → building`; lock as ruled; attempts as ruled, each: prepare the branch (not fresh), give the agent the `revise` task with `feedback`, `diff` (`workspace.diff(workdir, baseSha, 30000)`), `lockedFiles`, `criteria`, `checks`, `failures`, `attempt`; commit; guard protected paths changed since the round's start head and check files changed without a declaration (reset to the round's start head on a guard failure); verify as in `building`.
- No-change answer and success, failure and reply, as ruled. The pull request body is rendered from the updated state; the reply as ruled.
- Check changes are handled in Task 5; in this task a declared change is treated like an undeclared one (guard failure), so Task 5 has a clear seam.
- Tests, one per acceptance criterion except the check-change one: same branch and same pull request, no `openPullRequest`; all checks and project tests pass after a round; a round that fails every attempt ends in `needs_human` with the failure on the ticket and nothing pushed; body updated; reply with one line per feedback item and "No reply from the agent." for a missing one; the third round with the default limit goes to `needs_human` without running the agent; no-change answer posted and back to `pr_open`; feedback text appears in the prompt only inside the reviewer section; the runner sends an open `changes_requested` ticket to the engine and counts it toward the limit.

## Task 5: checks changed after review

Files: `src/core/steps/revise.ts`, tests.

- As ruled: a declared criterion's changed check files are allowed; Rumba runs that check on the base (checks commit with the new check content, scratch branch like relocation's `onTheBase`, never pushed by Rumba itself) where it must fail (not pass, not "could not run", not infrastructure), and on the change via the round's verification, where it must pass. The check gets `changedAfterReview: true`, its `before` result is replaced, the lock (`checkHashes`) takes the new hashes, and the reply lists the change with its reason.
- A declared change whose check passes on the base, or cannot run there, fails the attempt with that reason (given to the next attempt).
- An undeclared changed check file stays a guard failure.
- Tests: declared change accepted end to end with the evidence marked; declared change that passes on the base rejected; undeclared change rejected; a declared criterion that does not exist is ignored.
