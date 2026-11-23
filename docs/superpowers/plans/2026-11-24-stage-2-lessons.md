# Stage 2, part 4: turn review feedback into lessons

Spec: `docs/superpowers/specs/2026-11-20-rumba-design.md`, section 9 ("Lessons"), and GitHub issue #13 of this repository (acceptance criteria copied below). Builds on parts 1–3 (merged): pull request outcome tracking (src/core/steps/trackPullRequest.ts, `endTicket`), feedback collection (src/core/feedback.ts `selectFeedback`), review rounds (src/core/steps/revise.ts: `succeed`, `answerWithoutChange`).

## Goal

Feedback on one pull request should help the next ticket. After a review round, and when a pull request is closed without merging and had feedback, the agent is asked whether the feedback holds a general rule. If it does, Rumba (never the agent) appends it to `.rumba/<name>/lessons.md`, in the same pull request while it is open, or in a small pull request of its own once it was closed. A lesson takes effect only when a person merges it.

## Acceptance criteria (issue #13)

- After a round with a general rule, the pull request gets one extra commit that changes only `.rumba/<name>/lessons.md`, with the lesson and a link to the pull request.
- A pull request closed with feedback produces a separate pull request that changes only that file.
- A lesson is at most three lines and is cleaned like other output (secrets redacted, no feedback text quoted at length).
- Without a general rule, or without feedback, no commit and no pull request are made, and the state comment says why.
- The agent still cannot change anything under `.rumba/`; only Rumba writes the lesson.
- A lesson that is not merged never reaches the agent's context.

## Global constraints

- TypeScript, ESM (NodeNext imports end in `.js`), vitest. Existing style: short functions, comments that say why, plain English in messages.
- Every change starts with a failing test (write it, run it, see it fail for the right reason, then implement).
- Feedback is untrusted reviewer input (marked and fenced in prompts, as the `revise` task does). The lesson is untrusted agent output: it is validated and cleaned by Rumba before it is written, and Rumba writes the file, never the agent.
- Examples are invented: rumba `shop`, reviewers `alice`, `mallory`, tickets `#42`, lessons like "Totals are rounded to cents in `src/orders/total.ts`; round there, not in the view." No real project names.
- `npx vitest run`, `npm run typecheck`, `npm run build` pass at the end of each task.
- Commit after each task (`feat: …`, `fix: …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings (decided by the controller)

- **When.** After a review round that pushed or answered "no change needed" (not after a failed round), with the round's feedback. After a pull request is closed without merging (the ticket moves to `rejected`), with the feedback from people with write access written since Rumba first opened it (its first `pr_open` history time), read through `listFeedback` and filtered like round feedback (writers only, not Rumba, cleaned, at most 20). A label-only round with no feedback, or a closed pull request with none, asks no agent.
- **Run limit.** The lesson after a closed pull request runs within the outcome check, regardless of `max_tickets_per_run`: it is one agent call, and closed pull requests with feedback are rare.
- **The agent task.** New kind `distill-lesson`. Input: the ticket, the rumba's context (which already holds the merged `lessons.md`), and the feedback, in the reviewer-input section the `revise` prompt uses. Result: `{ kind: 'distill-lesson'; lesson?: string[]; none?: string }`, exactly one of the two: `lesson` is 1–3 lines of 1–200 characters each, `none` the reason there is no general rule (1–500 characters). The agent runs in a checkout of the default branch; whatever it writes there is discarded.
- **Validation (Rumba).** Each line is redacted (`redact` with the run's secrets), control characters and newlines replaced by spaces, trimmed, at most 200 characters; empty lines dropped; at most three lines. A lesson is refused (recorded as "the lesson quoted the feedback") when it holds any run of 40 consecutive characters of any feedback text (case-insensitive, whitespace collapsed on both sides).
- **The entry.** Appended to `.rumba/<name>/lessons.md` (created when missing), after a blank line, as:
  ```
  - <line 1>
    <line 2>
    From <pull request url>
  ```
- **How Rumba writes it.** A new workspace method `commitFile(workdir, path, content, message)` makes a commit on the worktree's branch that changes only `path` to `content`, built with git plumbing from the commit at HEAD (hash the content as a blob, a temporary index from HEAD, update that one entry, write the tree, commit with HEAD as parent, move the branch, reset the worktree to it), never by reading or writing files in the worktree. It refuses when any parent of `path` in HEAD's tree is not a directory (a symbolic link or file named `.rumba` or `.rumba/<name>`), or the existing entry at `path` is not a regular file. Same git safety options as the other commands.
- **Open pull request.** After the round's own push (and after a no-change answer), Rumba commits the lesson on the fix branch (fresh checkout of the branch) with message `docs: lesson from review of <ticket ref>` and pushes without force. The lesson commit changes only `lessons.md`.
- **Closed pull request.** Rumba prepares a fresh branch `rumba/<name>/lesson-<ticket id>` from the default branch, commits the lesson there, pushes it (force: the branch is Rumba's own), and opens a pull request: title `Lesson from review of <ticket ref> for the <name> rumba`, body: "Rumba drew this lesson from the review of <closed pull request url>. Merging it adds the lesson to `.rumba/<name>/lessons.md`, which the rumba reads from then on.", not a draft.
- **State.** `state.lessons?: { at: string; status: 'added' | 'none' | 'refused' | 'failed'; reason?: string; commit?: string; pullRequestUrl?: string }[]` (the latest 10; strict schema). `added` with the commit (and the lesson pull request url when there is one); `none` with the reason (the agent found no general rule, or there was no feedback); `refused` with why the lesson was refused; `failed` when the agent or git failed (the round or the outcome is never undone by a lesson failure).
- **Context.** Lessons reach the agent only through `lessons.md` read from the repository root (the default branch) when the config is loaded; a lesson committed on a branch is not in it until merged.

## Task 1: `Workspace.commitFile`

Files: `src/ports/workspace.ts`, `src/adapters/workspace/git.ts`, `src/testing/fakes.ts`, tests in `tests/adapters/workspace/git.test.ts` (real git) and the fake's tests.

- As ruled. Returns the new commit sha. The worktree ends at the new commit, with the file content as given.
- Tests (real git): the commit changes only that path, with HEAD as its parent, and the branch points to it; a new file is created, an existing one replaced; content with any bytes round-trips; refused when `.rumba` is a symbolic link in HEAD, when `.rumba/<name>` is a file, when the existing entry is a symbolic link or an executable or a directory; an untracked file the agent left in the worktree is not committed; the author is the workspace's commit author.
- Fake: records `{ workdir, path, content, message }` and returns a sha.

## Task 2: the `distill-lesson` agent task

Files: `src/ports/agent.ts`, `src/adapters/agent/prompts.ts`, `src/adapters/agent/result.ts`, tests.

- As ruled. Task text: "Decide whether the reviewers' feedback below holds a general rule worth keeping for later tickets in this repository. If it does, write it in one to three short lines: what was wrong, and what to do next time. Do not quote the feedback. If the feedback only concerns this change, give the reason there is no general rule instead. Do not change any file." The reviewer-input rule and fenced feedback section as for `revise` (reuse it).
- Tests: schema (exactly one of `lesson`/`none`, bounds); prompt contains the reviewer-input warning and fenced feedback, and stays under the byte limit with large feedback (feedback cut last, never dropped silently, as for `revise`).

## Task 3: lessons in core

Files: a new `src/core/lessons.ts`, `src/core/types.ts`, `src/core/stateComment.ts`, tests.

- `cleanLesson(lines, feedback, secrets)` → `{ lines } | { refused: string }` as ruled; `lessonEntry(lines, url)` → the text to append; `appendLesson(current, entry)` → the new file content (current `null` when missing; ensures exactly one blank line before the entry and a trailing newline).
- `learn(deps, rumba, ticket, state, { feedback, url, branch, push })`: asks the agent (checkout of the default branch, discarded), cleans, commits with `commitFile` on `branch`, and returns the lessons entry to record (`added`, `none`, `refused` or `failed`); never throws (agent and git errors become `failed` with a cleaned reason).
- `state.lessons` in the type and the strict schema (latest 10).
- Tests: cleaning (redaction, control characters, three-line cap, 200-character cap, quoting refused); entry and append; `learn` for each outcome with the fakes.

## Task 4: lessons after a round and after a closed pull request

Files: `src/core/steps/revise.ts`, `src/core/steps/trackPullRequest.ts`, `src/core/runner.ts` if needed, tests.

- After a round's push (`succeed`) and after a no-change answer (`answerWithoutChange`), with the round's feedback: `learn` on the fix branch, push without force when a lesson was committed, record the entry, write the state. A lesson failure never undoes the round.
- When a pull request is closed without merging (`endTicket`, moving to `rejected`): read the feedback since the first `pr_open`, select it as ruled; with none, record `none` ("the pull request was closed with no feedback"); with some, `learn` on a fresh lesson branch, push, open the lesson pull request, record `added` with its url.
- Tests, one per acceptance criterion: an extra commit on the same pull request changing only `.rumba/shop/lessons.md`, with the lesson and the link; a closed pull request with feedback opens a separate pull request changing only that file; no rule → no commit, no pull request, state says why; no feedback → the same, and no agent call; a refused lesson is recorded and nothing is written; the agent's attempt to write `.rumba/shop/lessons.md` itself in a round is still a guard failure; a lesson on a branch does not appear in `rumba.context` loaded from the repository root until it is on the default branch (config load test with a temp repository).
