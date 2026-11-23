# Stage 2, part 2: collect review feedback on Rumba's pull requests

Spec: `docs/superpowers/specs/2026-11-20-rumba-design.md`, sections 7, 8 and 9, and GitHub issue #11 of this repository (acceptance criteria copied below). Builds on part 1 (issue #10, merged): `merged`/`rejected` states, `CodeHost.getPullRequest`, `Tracker.listCandidates({ closedIn })`, and the `trackPullRequest` step the runner calls for every ticket in `pr_open`.

## Goal

For each ticket in `pr_open` whose pull request is still open, Rumba collects the feedback written after its last push by people with write access. When a review round is asked for, the ticket moves to `changes_requested` and the feedback is stored, cleaned and bounded, in the state comment. Acting on it is part 3 (issue #12); here the ticket only parks in `changes_requested`.

## Acceptance criteria (issue #11)

- A "changes requested" review from a user with write access, after Rumba's last push, moves the ticket to `changes_requested`.
- Line comments and pull request comments from such a user, after the last push, count as feedback too.
- An approval alone, or feedback older than Rumba's last push, changes nothing.
- Feedback from a user without write access is ignored, and its text is never stored or passed on.
- Comments written by the account Rumba runs as are never treated as feedback. (Since changed: see `docs/superpowers/plans/2026-11-24-own-comment-marker.md`, which recognises Rumba's own comments by a marker, not by author alone.)
- Adding `rumba-revise` to the pull request starts a round even with no "changes requested" review, and Rumba removes the label.
- Stored feedback is cleaned like check output (secrets redacted, size bounded).

## Global constraints

- TypeScript, ESM (NodeNext imports end in `.js`), vitest. Existing style: short functions, comments that say why, plain English in messages.
- Every change starts with a failing test (write it, run it, see it fail for the right reason, then implement).
- Feedback text is untrusted input, like ticket text: only authors with write access count, it is cleaned (`cleanOutput` with the run's secrets) and bounded, and text from anyone else is never stored, logged, posted or returned past the filter.
- Examples in code and tests are invented: rumba `shop`, repository `o/r`, reviewers `alice` (write access) and `mallory` (no write access), tickets `#42`. No real project names.
- `npx vitest run`, `npm run typecheck`, `npm run build` pass at the end of each task.
- Commit after each task (`feat: …`, `fix: …`, `test: …`), ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings (decided by the controller)

- **What starts a round.** A round starts when, after Rumba's last push, a person with write access submitted a review requesting changes, or when the pull request carries the `rumba-revise` label. Line comments and pull request comments alone do not start one (people discuss on pull requests), but once a round starts, every piece of feedback after the last push from people with write access is collected: reviews requesting changes, line comments and pull request comments. This reconciles "line comments and pull request comments count as feedback too" with "`rumba-revise` starts a round even with no changes-requested review".
- **Last push.** `openPullRequest` records `pushedAt` (the clock at the push) on the state. For a ticket that has none (opened before this change), the time of its last `pr_open` history entry is used.
- **Who counts.** The code host reports, for each piece of feedback, whether its author has write access (`admin`, `maintain` or `write` on the repository) and whether it is the account Rumba runs as. Core filters: it keeps only `canWrite && !self`. Text from anyone else is dropped in core before anything is stored. (Since changed: see `docs/superpowers/plans/2026-11-24-own-comment-marker.md`, which recognises Rumba's own comments by a marker, not by author alone.)
- **Bounds.** At most 20 pieces of feedback are kept, the newest last; each text is cleaned with `cleanOutput(text, secrets, 2000)`; a line comment keeps its path and line. If the state comment would exceed its size limit, the stored feedback texts are cut further before the comment is rejected (as check output already is).
- **The label.** Its name is configurable as `labels.revise` in `rumba.yml`, default `rumba-revise`. Rumba removes it from the pull request when it moves the ticket to `changes_requested`. The GitHub tracker's `ensureLabels` creates it, since issues and pull requests share labels on GitHub.
- **Parking.** Until part 3, a ticket in `changes_requested` is left alone by the runner (`left('changes requested')`), costs no run-limit slot, and is listed with closed tickets like `pr_open` (`closedIn: ['pr_open', 'changes_requested']`; status also lists it). `rumba-retry` restarts it from `queued`, as it does `pr_open`.
- **Ticket comment.** Moving to `changes_requested` posts on the ticket: "Review feedback arrived on the pull request (<n> comments). Rumba will revise the change on a later run: <url>". It quotes none of the feedback.

## Task 1: the `changes_requested` state, the revise label and stored feedback

Files: `src/core/types.ts`, `src/core/states.ts`, `src/core/labels.ts`, `src/config/schema.ts`, `src/config/load.ts` (via `mergeLabels`), `src/core/stateComment.ts`, `src/core/runner.ts`, `src/cli.ts`, `src/adapters/tracker/github.ts` (`ensureLabels`), `src/testing/fakes.ts`; tests alongside.

- State `changes_requested`: in `StateName` and `STATE_NAMES` (after `pr_open`), durable, not an end. `pr_open → changes_requested` is legal; from `changes_requested` the only moves for now are those every state has (`needs_human`) and `queued` by retry (extend `canTransition`'s retry rule to `changes_requested`).
- `LabelNames.revise`, default `rumba-revise`, overridable as `labels.revise` in `rumba.yml`; `ensureLabels` of the GitHub tracker creates it.
- On `TicketState`: `pushedAt?: string` and `feedback?: Feedback[]` with `interface Feedback { kind: 'review' | 'line' | 'comment'; author: string; url: string; at: string; text: string; path?: string; line?: number }`. The state comment schema validates both (strictly: the comment is untrusted). When the encoded comment is too large, feedback texts are cut (keep the end) before giving up, like check output.
- Runner: a ticket in `changes_requested` is left with `left('changes requested')` before the run limit, at no cost; retry restarts it (clearing `feedback`); the run and `rumba status` list closed tickets in `changes_requested` too.
- `openPullRequest` sets `pushedAt` to the clock time of the push.
- Tests: transitions; label default and override; schema round-trip with feedback, and refusal of a malformed feedback entry; size limit cuts feedback; runner parking, no limit cost, retry; `pushedAt` set on opening.

## Task 2: code host: feedback, labels on a pull request

Files: `src/ports/codeHost.ts`, `src/adapters/codeHost/github.ts`, `src/testing/fakes.ts` (`FakeCodeHost`), `src/wiring.ts` (`redactingCodeHost`, construction of `GitHubCodeHost`), tests.

- `PullRequestInfo` gains `labels: string[]`.
- `listFeedback(url: string, since: string): Promise<FeedbackItem[]>` with `interface FeedbackItem { kind: 'review' | 'line' | 'comment'; author: string; url: string; at: string; text: string; path?: string; line?: number; reviewState?: 'changes_requested' | 'approved' | 'commented'; canWrite: boolean; self: boolean }`. Only items strictly after `since`. Kinds: reviews (all states, with their body and `reviewState`), review comments on lines (`path`, `line`), and pull request (issue) comments. `canWrite` from the repository permission of the author (`admin`, `maintain`/`write` → true; `read`, `triage`, `none`, a bot or a 404 → false), looked up once per author per call. `self` when the author is the account Rumba runs as.
- `removeLabel(url: string, label: string): Promise<void>`: removes the label from the pull request; a 404 (label not there) is not an error.
- GitHub: the same URL check as `getPullRequest` (own repository only) before any request. The account Rumba runs as comes from a `login` given to the constructor (wiring passes `RUMBA_GITHUB_LOGIN` when set), else it is looked up like the GitHub tracker does (GraphQL viewer, then `GET /user`), and the lookup failing is an error, never "nobody is self". Paginate every list.
- Fake: `feedback: Map<url, FeedbackItem[]>` filtered by `since`; `labelsRemoved: { url; label }[]`; `getPullRequest` returns `labels` from a `pullRequests` entry (default `[]`).
- Tests (GitHub with the stub): each kind mapped; `since` respected; write and non-write authors; self; a permission 404; pagination; the URL check makes no request; `removeLabel` and its 404.

## Task 3: collect feedback and start a round

Files: `src/core/steps/trackPullRequest.ts`, a new `src/core/feedback.ts` (pure selection and cleaning), `src/core/runner.ts` if needed, tests.

- In `trackPullRequest`, when the pull request is open: `since` = `state.pushedAt` or, without it, the time of the last `pr_open` history entry. Read `listFeedback(url, since)`.
- `selectFeedback(items, secrets)` (pure): keep `canWrite && !self`; a round is asked for when any kept item is a review with `reviewState === 'changes_requested'`, or the pull request has the revise label. Approvals and `commented` reviews with an empty body are not stored. Clean each text with `cleanOutput(text, secrets, 2000)`, keep at most 20 (the newest), map to `Feedback`.
- When a round is asked for and there is at least one kept piece of feedback or the label is present: transition to `changes_requested` (note "review feedback"), store `feedback`, write the state, then remove the label from the pull request if it was there, then comment on the ticket as ruled. When the label is present but no feedback was written, the round still starts with an empty feedback list.
- Otherwise nothing changes (no write).
- Tests, one per acceptance criterion, with the fakes: changes-requested review from `alice` after the last push moves the ticket; line comment and pull request comment from `alice` are stored with the review; an approval alone changes nothing; feedback before `pushedAt` changes nothing; `mallory`'s review requesting changes changes nothing and her text appears nowhere in the stored state, the tracker comments or the label calls; a comment by the account Rumba runs as is ignored; the label starts a round and is removed; a secret in feedback text is redacted and a long text is cut; a ticket without `pushedAt` uses its `pr_open` history time.
