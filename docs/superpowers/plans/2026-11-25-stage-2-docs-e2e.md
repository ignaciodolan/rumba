# Stage 2, part 5: the round in the same run, the end-to-end review round, and the docs

Spec: `docs/superpowers/specs/2026-11-20-rumba-design.md`, sections 7 and 9, and GitHub issue #14 of this repository. It builds on parts 1 to 4 (issues #10 to #13, all merged): pull request outcome, collected feedback, the review round on the same pull request, and lessons. It also takes one improvement from a live run, asked for by the owner: a run that finds feedback carries out the review round straight away, instead of waiting for the next run.

## Acceptance criteria

From issue #14:
- The README describes every stage 2 state, label and setting, with invented examples only.
- The end-to-end suite covers one full review round with a lesson, and one ignored comment from a user without write access.
- `npx vitest run`, `npm run typecheck`, `npm run build` and `npm run test:e2e` pass.

From the owner:
- When a run finds feedback and moves a ticket from `pr_open` to `changes_requested`, it carries out the review round in the same run, within the ticket's time budget and the run limit, instead of waiting for the next run.

## Global constraints

- Code style: TypeScript, ESM (NodeNext imports end in `.js`), vitest. Short functions, comments that say why, plain English in messages.
- Tests: every code change starts with a failing test.
- Feedback is untrusted input: only writers count, and it is cleaned, bounded and marked as reviewer input.
- Examples in code, tests and docs are invented: rumba `shop`, repository `acme/shop`, reviewers `alice` (write access) and `mallory` (no write access), ticket `#42`. No real project names, repositories, people, paths or emails (README "Examples and privacy").
- Checks: `npx vitest run`, `npm run typecheck` and `npm run build` pass at the end of each task. The e2e suite runs only the small `fixtures/planted-bug` fixture.
- Commits: `feat: …`, `fix: …`, `test: …` or `docs: …`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings

- **When the round runs.** In `handle` (src/core/runner.ts), a ticket in `pr_open` whose tracking moves it to `changes_requested` goes on in the same pass to the engine path a ticket found in `changes_requested` takes:
  - It is checked against the run limit, takes a lease and is advanced by the engine.
  - It is not tracked a second time, since it was just read.
  - The engine sets a fresh per-ticket deadline (`advanceTicket`), so the round has the ticket's full time budget.
  - If the run limit is already reached, the ticket is left with `run limit` and stays in `changes_requested` for the next run, as today.
  - The summary lists both moves: `pr_open → changes_requested`, then the round's result.
  - Tracking still costs no run-limit slot; the round costs one, as a round always has.
- **The ticket comment.** The comment posted on the move to `changes_requested` no longer promises a later run. It reads: "Review feedback arrived on the pull request (<n> comments). Rumba will revise the change: <url>".
- **The e2e review round.** One more `it` in `tests/e2e/plantedBug.e2e.test.ts` (or a sibling file using the same fixture and helpers).
  - The first run opens the pull request as today.
  - Then the fake code host holds:
    - a changes-requested review from `alice` (write access), asking for a change the scripted agent can make (for example, also trimming surrounding spaces in the slug);
    - a pull request comment from `mallory` (no write access) with a distinctive text.
  - A second run carries out the round in the same run:
    - the scripted agent's `revise` makes the change on the same branch, and the checks still pass;
    - the pull request body is updated and a reply is posted;
    - the scripted agent's `distill-lesson` returns one line, so a lesson commit changing only `.rumba/<name>/lessons.md` is added on the same branch.
  - The test asserts:
    - the branch has the revise commit and then the lesson commit;
    - the lesson commit touches only that file;
    - the body and reply were written;
    - the state is `pr_open`, with one review round and one `added` lesson record;
    - `mallory`'s text appears nowhere: not in the state comment, the tracker comments, the pull request body or replies, nor any task the agent was given.
  - The case for a comment from a user without write access is a separate `it`: only `mallory` comments. Nothing changes: the ticket stays `pr_open`, nothing is written, and no agent task is run.
- **The README.** Replace the "Stage 2 … is not built yet" line and the "`max_review_rounds` … is not read yet" line. Document:
  - the states `changes_requested`, `merged` and `rejected`;
  - what counts as feedback and what starts a round (as built: see the design section below), and that Rumba's own comments are recognised by its marker, so running with the maintainer's own token works;
  - the `rumba-revise` label (`labels.revise`);
  - `max_review_rounds` (default 2);
  - how a check may change after review (the citation rule);
  - lessons: when they are drawn, the commit on an open pull request, the separate pull request after a closed one, and that a lesson takes effect only once merged;
  - the known limit that two open pull requests carrying lessons conflict in `lessons.md`, and that keeping both entries resolves it.
  Update the `lessons.md` line ("Edited by hand in stage 1").
- **The design.** Bring section 9 (and the matching rows of section 7) in line with what was built, and mark each difference from the original text with **(changed: …)**. The differences to mark:
  - **What starts a round:**
    - a writer's changes-requested review, a writer's line comment, or a commented review with a body, unless the same writer approved at or after it;
    - or the revise label, added by a writer after the last push;
    - plain pull request comments alone do not start a round, but are collected once one starts.
  - **Rumba's own comments** are recognised by a hidden marker line plus the account.
  - **A changed check** must cite a feedback item that names it.
  - **The round runs in the same run** that finds the feedback.
  - **Lessons** are plain lines, refused if they copy feedback at length. The state keeps the latest 10 records. The lesson pull request is not a draft.
  - **A retry** clears the stored feedback and review rounds. This contradicts section 7's "Feedback already recorded on the ticket is kept": mark it there.

## Task 1: carry out the review round in the same run

Files: `src/core/runner.ts`, `src/core/steps/trackPullRequest.ts` (comment text), tests in `tests/core/runner.test.ts` and `tests/core/steps/trackPullRequest.test.ts`.

- Tests (test first, with the fakes):
  - A ticket in `pr_open` with a writer's changes-requested review: one run moves it to `changes_requested`, then carries out the round. The revise agent task runs, the state ends `pr_open` with one round, and the summary has both moves.
  - The same with `maxTicketsPerRun: 1` and another ticket already worked first: the ticket stays `changes_requested`, left with `run limit`, and no revise task runs.
  - Tracking that leaves the ticket in `pr_open` changes nothing, as before.
  - The ticket comment text is the one ruled.
  - A round that fails in the same run counts one error, like any engine error, and leaves the ticket in `changes_requested`.

## Task 2: the end-to-end review round and the ignored comment

Files: `tests/e2e/plantedBug.e2e.test.ts` (or a new sibling e2e file), `fixtures/planted-bug` only if the review's change needs it. No source change unless the test finds a bug: if it does, report it with a failing unit test first.

- The two cases are as ruled above. The scripted agent gains `revise` and `distill-lesson` answers that edit only its workdir (or, for `distill-lesson`, only return lines).
- Run `npm run test:e2e`. It runs only this small fixture.

## Task 3: README and design

Files: `README.md`, `docs/superpowers/specs/2026-11-20-rumba-design.md`.

- As ruled above. Plain English, short sentences, invented examples only. Every setting and label name must match the code: check `src/config/schema.ts` and `src/core/labels.ts`.
