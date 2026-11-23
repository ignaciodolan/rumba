# Stage 2, part 1: track pull request outcome

Spec: `docs/superpowers/specs/2026-11-20-rumba-design.md`, sections 7 and 9, and GitHub issue #10 of this repository (acceptance criteria copied below).

## Goal

A ticket in `pr_open` is looked at on every run. Rumba reads its pull request through the code host and moves the ticket to `merged` when it was merged, to `rejected` when it was closed without merging, and leaves it in `pr_open` while it is open.

## Acceptance criteria (issue #10)

- A ticket in `pr_open` whose pull request was merged moves to `merged`, and the state comment records when.
- A ticket in `pr_open` whose pull request was closed without merging moves to `rejected`.
- A ticket whose pull request is still open stays in `pr_open` and does not count toward `max_tickets_per_run`.
- `merged` and `rejected` are end states: `rumba-retry` restarts them from `queued`, as with the other end states.
- `rumba status` shows the new states.
- A failure to read the pull request counts one error on the ticket and leaves it in `pr_open`.

## Global constraints

- TypeScript, ESM (NodeNext imports end in `.js`), vitest. Follow the code's existing style: short functions, comments that say why, plain English in messages.
- Every change starts with a failing test (write the test, run it, see it fail for the right reason, then implement).
- Examples in code and tests are invented: rumba `shop`, repository `o/r` or `acme/shop`, tickets `#42`, `ENG-12`. No real project names.
- The four commands must pass at the end of each task: `npx vitest run`, `npm run typecheck`, `npm run build`. (`npm run test:e2e` is run by the controller before the pull request is marked ready.)
- Commit after each task with a message in the repository's style (`feat: …`, `test: …`, `fix: …`) ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings (decided by the controller)

- **Closed tickets.** A merged pull request with `Closes #n` closes the GitHub issue, and the tracker today lists only open tickets, so Rumba would never see the ticket again. `Tracker.listCandidates` takes an option `closedIn: StateName[]`: it also returns closed tickets carrying the opt-in label whose state label is one of those states. The run asks for `['pr_open']`; `rumba status` asks for `['pr_open', 'merged', 'rejected']`.
- **Run limits.** Reading a pull request's outcome is a few API calls and no agent call. Neither staying open nor moving to `merged` or `rejected` counts toward `max_tickets_per_run`. A failed read counts as an error, as any other error does (one error on the ticket, and one toward the run's limit), and the third error on the ticket moves it to `needs_human` as today.
- **Exit comments.** As with the other end states, each move posts a comment: "The pull request was merged: <url>" and "The pull request was closed without merging: <url>".
- **When.** The `merged` history entry carries a note with the merge time the code host reports, for example `merged at 2026-01-02T03:04:05Z`; `rejected` carries the close time.

## Task 1: the `merged` and `rejected` states

Files: `src/core/types.ts`, `src/core/states.ts`, tests in `tests/core/states.test.ts`, `tests/core/stateComment.test.ts`, `tests/core/runner.test.ts`.

- Add `'merged' | 'rejected'` to `StateName`, to `STATE_NAMES` (after `fix_failed`), to `DURABLE` and to `ENDS`. In `MOVES`, `pr_open` may move to `merged` and `rejected`; both have no moves of their own. `canTransition` already lets every end state go to `queued` and every state go to `needs_human`.
- The state comment schema reads `STATE_NAMES` and `DURABLE`, so it needs no change; prove a state in `merged` round-trips through `encodeStateComment`/`decodeStateComment`.
- Tests: `pr_open → merged` and `pr_open → rejected` are legal; `merged → pr_open`, `rejected → building` are not; both are durable and end states; a ticket in `merged` or `rejected` with the `rumba-retry` label is restarted from `queued` by the runner (fixAttempts and errorCount reset, retry label removed), like `fix_failed` today; a ticket in `merged` or `rejected` without the label is left alone (`left` with the state name), and does not count toward the run limit.
- The state labels are created from `STATE_NAMES` by `ensureLabels`, so `rumba-state:merged` and `rumba-state:rejected` appear without other changes; check the tracker tests still pass.

## Task 2: `CodeHost.getPullRequest`

Files: `src/ports/codeHost.ts`, `src/adapters/codeHost/github.ts`, `src/testing/fakes.ts` (`FakeCodeHost`), `src/wiring.ts` (`redactingCodeHost` passes it through), tests in `tests/adapters/codeHost/github.test.ts` and `tests/testing/fakes.test.ts` or a new test file.

- Port: `getPullRequest(url: string): Promise<PullRequestInfo>` with `interface PullRequestInfo { state: 'open' | 'merged' | 'closed'; headSha: string; mergedAt?: string; closedAt?: string }`.
- GitHub: parse the pull request number from the URL. Accept only `https://github.com/<owner>/<repo>/pull/<n>` for this host's own owner and repository (compare case-insensitively); anything else throws a clear error. Call `pulls.get`; `merged` (or `merged_at` set) → `merged`; `state === 'closed'` otherwise → `closed`; else `open`. `headSha` from `head.sha`.
- Fake: `pullRequests: Map<string, PullRequestInfo>`; `getPullRequest` returns the entry, or `{ state: 'open', headSha: 'head0' }` for a URL it opened itself; an unknown URL throws. A way to make it throw (`pullRequestError: Error | null`) for the error test.
- Tests: open, merged, closed-not-merged, a URL for another repository or not a pull request URL is refused before any request is made, a 404 propagates.

## Task 3: list closed tickets still in a given state

Files: `src/ports/tracker.ts`, `src/adapters/tracker/github.ts`, `src/adapters/tracker/linear.ts` (and its gateway interface and SDK gateway), `src/testing/fakes.ts` (`FakeTracker`), `src/testing/trackerContract.ts`, `tests/adapters/tracker/linearMemory.ts`, `tests/adapters/tracker/githubStub.ts` if needed, tracker tests.

- Port: `listCandidates(opts?: { closedIn?: StateName[] }): Promise<Ticket[]>`. Open tickets with the opt-in label, as today, plus closed tickets with the opt-in label whose state label (`stateLabel(labels, s)`) is one of `closedIn`. No ticket twice.
- GitHub: for each state in `closedIn`, one more paginated `issues.listForRepo` with `state: 'closed'` and `labels: '<optIn>,<state label>'`; pull requests filtered out as today.
- Linear: the gateway's `issues` takes `closed?: boolean`; when set, the filter selects closed state types instead of excluding them. Filter by the state label in code.
- Fake: the existing `closed` set; closed tickets are returned when their state (from `states`) is in `closedIn`.
- Contract tests (run for every tracker): a closed ticket in `pr_open` is listed with `closedIn: ['pr_open']` and not without it; a closed ticket in another state is not listed; an open ticket is listed once even when its state is in `closedIn`.

## Task 4: the run reads the pull request of each ticket in `pr_open`

Files: a new step `src/core/steps/trackPullRequest.ts`, `src/core/runner.ts`, `src/cli.ts` (`trackerStatus`), tests in `tests/core/steps/trackPullRequest.test.ts`, `tests/core/runner.test.ts`, `tests/cli.test.ts`.

- `trackPullRequest(deps, rumba, ticket, state)`: requires `pr_open` and a `pullRequestUrl` (throw otherwise). Reads `deps.codeHost.getPullRequest(url)`.
  - `merged` → `transition(state, 'merged', now, 'merged at <mergedAt>')` (or `merged` without a time when none is given), write the state, then comment "The pull request was merged: <url>".
  - `closed` → `rejected` the same way, note `closed at <closedAt>`, comment "The pull request was closed without merging: <url>".
  - `open` → return the state unchanged, nothing written.
- Runner: the run lists candidates with `closedIn: ['pr_open']`. Where it now returns `left(state.state)` for `pr_open`, it calls the step instead, before the run-limit check, without a lease. Merged or rejected tickets go into `summary.advanced` (from `pr_open`); an open one is `left('pull request open')`. None of these counts toward `max_tickets_per_run`: the run limit counts only tickets the engine worked plus errors. A thrown error (from the code host) is handled like an engine error: one error on the ticket, state stays `pr_open`, one error toward the run's limit, `left('error: …')`, and at the third error the ticket goes to `needs_human` with the comment "Rumba hit repeated errors on this ticket: …".
- `rumba status` lists tickets with `closedIn: ['pr_open', 'merged', 'rejected']`, so a merged ticket whose issue the merge closed still shows `merged`.
- Tests: each acceptance criterion above, with the fakes; three tickets in `pr_open` with open pull requests and `maxTicketsPerRun: 1` still let a queued ticket be worked in the same run; a merged one moves even when the run limit is already reached; status prints `merged` for a closed ticket.
