# Rumba: design

Date: 2026-11-20. Status: revision 2, waiting for approval. Revision 1 was approved; revision 2 adds named rumbas (section 6) and the pull request feedback loop (section 9).

Amended after stage 1 was built: sections 3 and 12 now say where the commands of the Docker environment run. The earlier text had them run in a checkout of the code under test, which let a file written by the agent be read or executed on the host.

Lines marked **(call)** are choices biggie made that the owner has not explicitly agreed to. Everything else was decided in conversation.

## 1. Intent

Rumba is an open-source tool that picks up labelled tickets from an issue tracker and takes each one to a pull request. It only opens the pull request after it has evidence: checks that fail on the current code and pass on the change.

A repository can run several rumbas. Each has a name, covers one part of the codebase, carries its own context, and can use its own agent and model. When a pull request gets review feedback or is closed, the rumba takes the feedback in and keeps what it learned.

Why it exists:

- The owner wants to build it to learn.
- It will be open source so the owner's customers can use it without paying for a product.
- Several open-source tools already turn tickets into pull requests (OpenHands, Lisa, Agent Smith, Symphony, Cyrus). None of the descriptions found mention reproducing the problem first or verifying the fix afterwards. That evidence loop is Rumba's reason to exist. This gap was read from listings and reviews, not from each project's README.

## 2. Goals, non-goals, anti-goals

Goals:

- An evidence loop for bugs and for new features.
- Several named rumbas per repository, each a specialist in one area.
- Review feedback on a rumba's pull request flows back into that rumba, both to fix that pull request and as a lesson for later tickets.
- Three plug points: issue tracker, coding agent, environment.
- One command that behaves the same on a laptop and in scheduled CI.
- Cheap adoption: a config folder, one workflow file, and keys.
- An explicit state machine whose state is visible on the ticket.

Non-goals for v1:

- Merging pull requests or deploying.
- A hosted service, a dashboard or a database.
- Rumba's own agent loop. It drives existing coding agents.
- Routing tickets to a rumba automatically. A person picks the rumba with a label. **(call)**
- Learning from pull requests that were merged without comment. **(call)**
- Reading criteria from external services such as Notion or Google Docs.
- Tickets that span more than one repository. **(call)**
- Starting from webhooks. v1 is scheduled or run by hand. **(call)**

Anti-goals, meaning outcomes that make Rumba a failure even if it runs:

- A pull request that claims a verification that did not happen.
- Rumba approving acceptance criteria it wrote itself.
- A rumba keeping a lesson that no person approved.
- Rumba acting on feedback from someone without write access to the repository.
- Rumba touching a ticket that does not carry a rumba's opt-in label.
- Keys or tokens appearing in ticket comments, pull requests or agent prompts.

## 3. Constraints

- TypeScript on Node. **(call, stated in conversation and not objected to)**
- No server and no database. State lives on the ticket; context and lessons live in the repository.
- A run must fit inside a CI job, so each ticket has a time budget.
- Ticket text and review comments are untrusted input. The coding agent has shell access, so:
  - only people who can label tickets can opt a ticket in or approve criteria;
  - only feedback from people with write access to the repository is used;
  - the agent and the checks always run in a throwaway container with only the repository working copy mounted, on a laptop and in CI alike. Docker is therefore required wherever Rumba runs, including for projects whose environment is Vercel preview. (Decided by the owner.)
  - the agent container receives the model key and nothing else. Tracker, code host and Vercel tokens stay in the Rumba process, which does the pushing and commenting itself. **(call)**
  - the container has network access, because the agent must reach its model and install packages. Restricting it is not part of v1. **(call)**
  - a check container gets only what the check needs, such as the target URL and the Vercel bypass token. Rumba removes known secret values from check output before posting it anywhere. **(call)**
  - the agent may not change anything under `.rumba/`. A change there fails verification. Only the Rumba process writes lessons. **(call)**
  - the commands an environment runs on the host (for Docker: up, exec and down) never run in a directory the agent wrote to. They run in a checkout of the default branch, which holds only code a person merged and which Rumba compares with its commit before each command. They receive the code under test as a path in `RUMBA_WORKDIR`, and that code may reach a container only as a mount or a build context. The list of protected paths is a second layer, not the boundary. (Decided by the owner.)
  - git on the host reads the agent's files as content to commit, never as configuration: the repository is named explicitly, hooks are off, a working copy that holds another git repository is refused, and git attributes are not read from the working copy or the commit, so no filter, diff or merge driver is selected by the agent. A consequence is that Rumba's checkouts hold Git LFS pointer files, not the real files. (Decided by the owner.)
- Licence: MIT. **(call)**
- Name: the repository and the command are `rumba`. The npm name `rumba` is taken by an abandoned package, so the package is published as `rumba-cli`. **(call)**

## 4. Approaches

### What does the fixing

1. **Drive an existing coding agent (chosen).** Rumba runs Claude Code or Gemini CLI as a subprocess. "Pluggable model" becomes "pluggable agent and model". The owner learns orchestration, state, environments and evidence, and customers get fix quality from mature agents.
2. **Own agent loop.** Rumba calls model APIs with its own file and shell tools. Much more work, and fix quality would lag for a long time. The agent interface is narrow enough that this can be added later as one more agent.

This was biggie's pick. The owner did not object when it was stated as the plan.

### Shape of the tool

1. **One CLI, state on the ticket (chosen by the owner).** No database. The same command runs locally or in GitHub Actions. Trade-off: history is only as rich as what fits on a ticket, and long runs are bound by CI limits.
2. **CLI with a local SQLite file.** Richer history, but a laptop run and a CI run do not share state.
3. **Always-on service** with Postgres, webhooks and a scheduler. Most capable, but every customer hosts a server and the build is two to three times larger.
4. **Hosted multi-tenant service.** Dropped early: customers do not want to pay and the owner would be running it for them.

The state store sits behind an interface so options 2 and 3 stay possible.

### Where a rumba keeps what it learns

1. **In the repository, through a pull request (chosen by the owner).** Lessons go in the rumba's `lessons.md`. A person approves each lesson by merging it. Versioned and reviewable.
2. **In the repository, by direct commit.** Faster, but nobody controls what the rumba learns, and it needs permission to write to the main branch.
3. **On the tracker,** as comments on one pinned ticket per rumba. Leaves the repository alone, but is harder to review and to version.

## 5. Concepts

- **Rumba**: a named instance with its own scope, context, agent, model and environment.
- **Ticket**: an issue in a tracker that carries one rumba's opt-in label.
- **Kind**: `bug` or `feature`, decided at triage.
- **Criterion**: one statement of what done means. A bug has one: "this no longer happens".
- **Check**: a command that exits 0 when a criterion holds and non-zero when it does not.
- **Evidence**: for each criterion, the check's result before the change and after it.
- **Feedback**: a review or comment on a rumba's pull request from someone with write access.
- **Lesson**: one short rule a rumba distilled from feedback, kept in its `lessons.md`.
- **Run**: one invocation of `rumba run`.

## 6. Named rumbas

Each rumba is a folder under `.rumba/` in the repository. The folder name is the rumba's name.

```
.rumba/
  hub/
    rumba.yml      # scope, tracker, agent, model, environment, limits
    context.md     # written by people: what to know about this area
    lessons.md     # appended by Rumba through pull requests
  api/
    ...
```

- **Name**: lowercase letters, digits and hyphens. The folder makes it unique within a repository.
- **Scope**: `paths` in `rumba.yml` lists the globs the rumba is expected to work in. A change outside them is allowed but listed in the pull request as outside scope. It is not blocked, because real fixes often touch shared code. **(call)**
- **Context**: `context.md` and `lessons.md` are given to the agent on every task.
- **Agent, model, environment, limits**: set per rumba. One rumba can use a cheaper model, or Vercel preview where another uses Docker.

How names avoid collisions **(call)**:

| Thing | Form | Example |
|---|---|---|
| Opt-in label, added by a person | `rumba:<name>` | `rumba:hub` |
| State label, managed by Rumba | `rumba-state:<state>` | `rumba-state:building` |
| Signals, added by a person | `rumba-approved`, `rumba-retry` | |
| Fix branch | `rumba/<name>/<ticket-id>` | `rumba/hub/123` |
| Lesson branch | `rumba/<name>/lesson-<ticket-id>` | `rumba/hub/lesson-123` |

State labels use a different prefix from opt-in labels, so a rumba can have any name without colliding with a state. This replaces the `rumba:approved` and `rumba:retry` names used in revision 1.

- A ticket belongs to exactly one rumba. A ticket with two opt-in labels is taken by none, and Rumba comments on it once to say so.
- The state comment records which rumba owns the ticket.
- Lessons grow over time. Consolidating them is not part of v1; people edit `lessons.md` by hand. **(call)**

## 7. State machine

```
queued → triaged → criteria_ready → env_ready → checks_failing → building → verified → pr_open
            │            ↑                │                         ↑  │                 │
            ↓            │                ↓                         │  ↓                 ├→ merged
         skipped   awaiting_criteria   not_reproducible             │ fix_failed         ├→ rejected
                                       needs_human                  │                    ↓
                                                                    └──────── changes_requested
```

| State | What happens there | Next |
|---|---|---|
| `queued` | Ticket has a rumba's opt-in label and no state. | `triaged` |
| `triaged` | Agent reads the ticket and repo, decides kind and whether Rumba can work it. | `skipped`, `criteria_ready` or `awaiting_criteria` |
| `awaiting_criteria` | Feature with no usable criteria. Rumba has posted a draft and waits for a person. | `criteria_ready` once `rumba-approved` is added |
| `criteria_ready` | Criteria are fixed for this ticket. | `env_ready` |
| `env_ready` | Environment is up at the base commit. Agent writes the checks. Rumba runs them. | `checks_failing`, `not_reproducible` or `needs_human` |
| `checks_failing` | Every check fails on the base commit, as expected. | `building` |
| `building` | Agent writes or revises the change on the fix branch. | `verified` or `fix_failed` |
| `verified` | Every check passes against the change. | `pr_open` |
| `pr_open` | Pull request is open with the evidence. Each run looks at it again. | `merged`, `rejected` or `changes_requested` |
| `changes_requested` | Feedback has arrived and is recorded in the state comment. | `building`, or `needs_human` after the allowed rounds |
| `merged` | Pull request was merged. End. | none |
| `rejected` | Pull request was closed without merging. End, unless retried. | none |

Where criteria come from:

- **Bug**: Rumba derives the single criterion from the report and continues without approval. A failing check on the base commit is objective evidence, so there is no homework problem. **(call)**
- **Feature with criteria**: Rumba uses them as written. It reads criteria from three places only: the ticket itself, files in the repository that the ticket names, and documents native to the tracker, such as Linear documents. It does not open external links such as Notion or Google Docs. (Decided by the owner.)
- **Feature without criteria**: Rumba drafts them, posts them as a comment and parks the ticket in `awaiting_criteria`. A person adds `rumba-approved` to accept the draft as posted. To change it, they write the final criteria in the ticket description under an "Acceptance criteria" heading and then add the label. On approval Rumba uses the description section if there is one, otherwise its own draft. Rumba never treats its own draft as approved without the label. **(call: the conversation said a person could edit Rumba's comment. Linear appears to let only the author edit a comment, so the description is used instead. Not verified against Linear.)**

Exits, each of which posts a comment saying why:

- `skipped`: triage judged the ticket not workable.
- `not_reproducible`: a bug's check passes on the base commit.
- `needs_human`: a feature's checks already pass before any change, a time budget ran out, repeated errors, or review rounds ran out.
- `fix_failed`: checks still fail after the allowed fix attempts (default 2).

Re-entry: a person adds `rumba-retry` and Rumba resets the ticket to `queued`. Feedback already recorded on the ticket is kept and given to the agent on the new attempt. **(call)**

Criteria that cannot be checked by a command, such as "feels fast on mobile", are listed in the pull request as not verified. They never count as passed. If any exist, the pull request is opened as a draft. **(call)**

### Durable and transient states

A run can die partway. States are split so that a dead run cannot strand a ticket. **(call)**

- Durable: `queued`, `awaiting_criteria`, `criteria_ready`, `pr_open`, `changes_requested`, and the six ends (`skipped`, `not_reproducible`, `needs_human`, `fix_failed`, `merged`, `rejected`). A ticket can rest here between runs.
- Transient: `triaged`, `env_ready`, `checks_failing`, `building`, `verified`. These exist only inside a run.
- A run takes a lease on a ticket before working it: its run id and a timestamp in the state comment. A ticket found in a transient state with a lease older than the per-ticket budget is reset to its last durable state.
- Two runs of the same rumba at once are discouraged with a CI concurrency group per rumba. The lease is best effort, not a lock.

## 8. State on the ticket

- Labels as listed in section 6: one opt-in label, exactly one state label, and the two signals.
- One state comment that Rumba owns and edits in place. It has a short summary for people and a machine-readable block holding rumba name, state, kind, criteria, attempt count, review round, branch, pull request URL, feedback already handled, lease and a short history.
- One criteria comment, separate, written as a checklist.

Label names are configurable. Defaults are the ones above.

## 9. Pull request feedback loop

On every run, for each ticket in `pr_open`, Rumba reads its pull request:

- **Merged**: ticket moves to `merged`.
- **Closed without merging**: ticket moves to `rejected`. Rumba distils a lesson from the feedback on it, if there is any.
- **Feedback since Rumba's last push**: ticket moves to `changes_requested`, then on to `building`.
- **Nothing new, or only approvals**: nothing happens.

What counts as feedback **(call)**: a review that requests changes, or a review comment or pull request comment, written after Rumba's last push by someone with write access to the repository. Comments from anyone else are ignored and never reach the agent.

Revising:

- The agent revises the change on the same branch, with the feedback in front of it.
- Checks stay locked, as in section 11, unless the feedback says a check or a criterion is wrong. In that case the agent may change the check, Rumba runs it again against the base commit and against the change, and the evidence table marks it as changed after review. **(call)**
- Rumba pushes to the same pull request, updates the evidence in its body, and replies on the pull request saying what changed.
- At most two review rounds per pull request (`max_review_rounds`, default 2). After that the ticket moves to `needs_human`. **(call)**

Lessons:

- After handling feedback, the agent is asked whether it holds a rule worth keeping for later tickets. If so it writes one to three lines: what was wrong, and what to do next time.
- Rumba appends the lesson to `.rumba/<name>/lessons.md` with a link to the pull request it came from.
- If the pull request is still open, the lesson is one more commit in it, so merging the fix also approves the lesson.
- If the pull request was closed, Rumba opens a small pull request on `rumba/<name>/lesson-<ticket-id>` that changes only `lessons.md`.
- If the agent finds no general rule, or the pull request was closed with no feedback at all, nothing is added and the state comment says so. **(call)**
- A lesson only takes effect once a person merges it. Until then the rumba does not have it.

## 10. Plug points

Sketches, not final signatures.

```ts
interface Tracker {
  listCandidates(rumba: string): Promise<Ticket[]>     // tickets with that rumba's opt-in label
  readState(t: Ticket): Promise<TicketState | null>
  writeState(t: Ticket, s: TicketState): Promise<void>   // labels + state comment
  postCriteria(t: Ticket, c: Criterion[]): Promise<void>
  readApprovedCriteria(t: Ticket): Promise<Criterion[] | null>
  comment(t: Ticket, body: string): Promise<void>
}

interface Agent {
  // task is one of: triage, draft-criteria, write-checks, fix, revise, distill-lesson
  // always executed inside the sandbox container, with workdir mounted
  run(task: AgentTask, workdir: string): Promise<AgentResult>
}

interface Environment {
  up(ref: { branch: string; sha: string }): Promise<EnvHandle>   // handle has baseUrl and/or exec
  runCheck(h: EnvHandle, check: Check): Promise<CheckResult>     // exit code, output, artifacts
  down(h: EnvHandle): Promise<void>
}

interface CodeHost {
  pushBranch(branch: string): Promise<void>
  openPullRequest(pr: PullRequestDraft): Promise<string>         // returns URL
  updatePullRequest(url: string, body: string): Promise<void>
  getPullRequest(url: string): Promise<{ state: 'open' | 'merged' | 'closed' }>
  listFeedback(url: string, since: Date): Promise<Feedback[]>    // write-access authors only
  reply(url: string, body: string): Promise<void>
}
```

What ships in v1 **(call)**:

| Plug point | v1 | Later |
|---|---|---|
| Tracker | GitHub Issues, Linear | Jira |
| Agent | Claude Code, Gemini CLI | Codex, own loop |
| Environment | Docker, Vercel preview | others |
| Code host | GitHub | GitLab |

Two of each of the first three, so the interfaces are proven by a second implementation.

## 11. Checks and evidence

- A check is a command. Exit 0 means the criterion holds.
- The agent prefers the project's existing test framework and falls back to a standalone script. **(call)**
- Checks are committed on the fix branch, so they arrive in the pull request as regression tests. **(call)**
- After `checks_failing`, Rumba records a hash of every check file. If a check file changed during `building`, verification fails. This stops the agent passing by editing the test. The one exception is a revision where the feedback asked for it, described in section 9. **(call)**
- For URL-based environments, checks read the target from `RUMBA_BASE_URL`.
- If the rumba's config names the project's own test command, Rumba also runs it against the change. A failure there counts as a failed fix attempt, so a fix that breaks other tests does not reach `verified`. This applies where the environment can run commands, which means Docker and not Vercel preview. **(call)**

Pull request body:

- link to the ticket, and which rumba produced it;
- a table of criterion, check, result before, result after;
- criteria not verified, if any;
- files changed outside the rumba's scope, if any;
- trimmed check output;
- which environment, agent and model were used.

## 12. Environments

### Docker

- The rumba's config gives the commands to bring the project up, run something inside it, and take it down.
- These commands run on the host, so they never run in the code under test. Each runs with its working directory in a fresh checkout of the default branch, at the commit the fix branch started from. Whatever a command reads by relative path is a file a person merged: compose files and what they include, `.env`, a Makefile, a script, a Dockerfile.
- The code under test is checked out in a second directory. Its path is given to the commands in `RUMBA_WORKDIR` and in no other way. The project's compose file hands that path to the container, as a mount (`${RUMBA_WORKDIR:-.}:/app`, which also works when run by hand) or as a build context.
- Before-run: check out the checks commit (the base commit plus the check files), up, run checks, down.
- After-run: check out the fix commit, up, run checks, down.
- Both runs use the same default-branch commit for the host side, so the environment is defined the same way before and after, and the evidence stays comparable.
- A change to a compose file or a Dockerfile in a fix cannot be verified this way, because the environment is built from the default branch's copies. Such files are protected by default and a fix that changes them is rejected.
- The config author must give `RUMBA_WORKDIR` to Docker only, never read or run a file under it on the host, and mount the directory itself, not a folder below it. Rumba cannot check this.
- Before each host command Rumba compares the default-branch checkout with its commit, file by file, and runs nothing there once it differs; the environment is then taken down from a fresh copy. So a container must not be given that checkout to write to, and the commands must not write into it. The checkout and the code under test sit in separate temporary folders.

### Vercel preview

- Checks never run against production. The deployment of the default branch is usually production, with different data and settings from a preview, so it is not used. **(call)**
- Before-run: push a throwaway branch `rumba/<name>/base-<ticket-id>` at the base commit, wait for its preview deployment, run checks against that URL.
- After-run: push the fix branch, wait for its preview deployment to be ready, run checks against that URL.
- Before and after therefore run as previews with the same settings, which keeps the evidence comparable.
- `down` deletes the throwaway base branch.
- Checks are limited to what is visible over HTTP or in a browser. Bugs that need database state or logs fit Docker better.
- Protected previews need Vercel's automation bypass token, sent as a header by the checks.
- The fix branch is pushed before it is verified. This is unavoidable here, since a preview only exists for a pushed commit.

## 13. Config

One file per rumba, at `.rumba/<name>/rumba.yml`.

```yaml
paths:
  - apps/hub/**
tracker:
  kind: github            # github | linear
  # linear only: which tickets belong to this repository
  # team: ENG
  # project: Checkout
agent:
  kind: claude-code       # claude-code | gemini-cli
  model: claude-haiku-5-5 # optional; the agent's default if omitted
environment:
  kind: vercel-preview    # docker | vercel-preview
  # docker only:
  # up: docker compose up -d --wait
  # exec: docker compose exec -T app
  # down: docker compose down -v
verify:
  test: npm test          # optional: the project's own tests, run against the change
limits:
  max_tickets_per_run: 3
  minutes_per_ticket: 30
  max_fix_attempts: 2
  max_review_rounds: 2
```

Keys come from environment variables, never from this file.

A Linear label is shared across a workspace, so a Linear tracker must also name a team, and may name a project. Without that, two repositories with a rumba of the same name would claim the same ticket. **(call)**

GitHub access is a token the user supplies, either a fine-grained personal token or a GitHub App token. The default GitHub Actions token also works, but pull requests opened with it do not start the repository's own CI, and `rumba init` says so. **(call)**

## 14. Commands and scheduling

- `rumba run`: run every rumba in the repository, one after another.
- `rumba run --name <name>`: run one rumba. It scans the tracker and its open pull requests, and advances each ticket until it reaches a durable state or its budget ends.
- `rumba run --name <name> --ticket <id>`: the same for one ticket.
- `rumba status`: list tickets and their states, grouped by rumba.
- `rumba init <name>`: create `.rumba/<name>/` with a starter `rumba.yml`, an empty `context.md` and `lessons.md`, and a GitHub Actions workflow if there is none.

Scheduling is a GitHub Actions workflow with a cron trigger and a manual trigger. It runs one job per rumba, each with its own concurrency group, so rumbas run side by side without two runs of the same one overlapping. Locally it is run by hand or from cron.

## 15. Errors

- An unexpected error leaves the ticket at its last durable state and adds one to an error count in the state comment.
- After three errors on the same ticket it moves to `needs_human`. **(call)**
- A ticket that runs out of time moves to `needs_human`.

## 16. Build order

Two stages, each usable by itself. **(call)**

1. **Core loop with named rumbas.** Everything up to `pr_open`. Names shape labels, branches and config, so they are cheaper to build in from the start than to add later.
2. **Feedback loop and lessons.** Section 9: `merged`, `rejected`, `changes_requested`, revising, and lessons.

Each stage gets its own build plan.

## 17. Testing Rumba itself

- State machine: unit tests against in-memory fake tracker, agent, environment and code host, including the feedback transitions.
- Each adapter: the same contract tests run against every implementation of an interface.
- Feedback filter: comments from authors without write access never reach the agent.
- End to end: one fixture repository with a planted bug, run through Docker.

## 18. Left to the builder

- How the machine-readable block is encoded in the state comment for each tracker.
- Whether the state machine is a hand-written transition table or uses a library.
- CLI library and package layout.
- The prompt for each agent task, and how the agent hands back structured results.
- Whether flaky checks are detected by running the before-run twice.
- The sandbox container image: what it contains and how the agent CLIs are installed in it.
- How write access is determined for a feedback author on GitHub.

## 19. Not yet decided

- Which GitHub account or organisation owns the repository, and when it is created. Nothing is created until the owner says so.
