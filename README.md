# Rumba

Rumba is an open-source tool that picks up labelled tickets from an issue tracker and takes each one to a pull request. It only opens the pull request after it has evidence: checks that fail on the current code and pass on the change.

## Status

This is stage 1: Rumba takes a ticket from its label to an open pull request. What is not done yet:

- The package is not published to npm. `npx rumba-cli` and the generated workflow will work once it is; until then, build it from this repository (`npm install && npm run build`, then `node dist/cli.js` or `npm link`).
- The sandbox image is not pushed to any registry. Rumba builds it locally from `sandbox/Dockerfile` the first time `rumba run` needs it, which takes a few minutes and counts toward that ticket's time. Its tag is `rumba-sandbox:node<version>-<hash of the Dockerfile>`, so another Node version or a newer Dockerfile builds a new image; old ones are not removed (`docker image prune` or `docker rmi`).
- No live run against a real tracker or model has been made. The adapters are tested against fakes, stubs, local git and local Docker.
- Stage 2 (acting on pull request review feedback, noticing merged and closed pull requests, writing lessons) is not built yet.

## Requirements

- Node 22 or later.
- git.
- Docker, everywhere Rumba runs, on a laptop and in CI. The agent and the checks always run in a container, also for projects whose environment is a Vercel preview.
- A GitHub repository. Stage 1 supports GitHub remotes only (`origin` must be on github.com).

## Setup

From inside your repository:

```sh
rumba init shop
```

This creates:

- `.rumba/shop/rumba.yml`: the rumba's config (see below). The starter file uses the GitHub tracker, the Claude Code agent and a Docker environment; edit it to match your project.
- `.rumba/shop/context.md`: what the agent should know about this area of the code. Written by people.
- `.rumba/shop/lessons.md`: lessons from earlier tickets. Edited by hand in stage 1.
- `.github/workflows/rumba.yml`, if it does not exist: a workflow that runs every 30 minutes and on demand, one job per rumba. Each later `rumba init <name>` adds the new name to its matrix. If the file exists and was not written by `rumba init`, add the name by hand.

Then add the keys the rumba needs as repository secrets (see [Environment variables](#environment-variables)) and commit the files.

Before you enable the workflow:

- `rumba-cli` is not published to npm yet, and until the name is taken anyone could publish a package under it. The workflow's `npx rumba-cli run` step is ready for when it is. Until then, do not enable the workflow, or replace that step with an install from a checkout of Rumba you trust.
- With the default Actions token, turn on the repository setting "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General). Without it, opening the pull request fails after all the work is done.
- Keep the checkout step's stored credentials, which is the default: do not set `persist-credentials: false`. Rumba fetches the default branch with them.

A rumba name uses lowercase letters, digits and hyphens. It is the folder name under `.rumba/`, and a repository can have several rumbas, each with its own scope, agent, model and environment.

## How a ticket moves

Labels are the interface. Rumba creates all of them, the opt-in label `rumba:<name>` included, the first time it runs.

| Label | Added by | Meaning |
|---|---|---|
| `rumba:<name>` | a person | Opts the ticket in to that rumba. A ticket with two of them is taken by none, and Rumba says so once. |
| `rumba-state:<state>` | Rumba | The ticket's current state. Exactly one at a time. |
| `rumba-approved` | a person | Accepts the acceptance criteria Rumba drafted. |
| `rumba-retry` | a person | Starts a ticket at an end state, or with an open pull request, again from `queued`. |

Rumba also keeps one state comment on the ticket, which it edits in place, and posts one comment for each exit saying why.

On each run Rumba takes each opted-in ticket as far as it can:

1. `queued`: the ticket has the opt-in label and no state yet. With the docker environment, before any agent call, Rumba brings the environment up once on the default branch and runs the project's own tests (`verify.test`) there, if set. If the environment does not come up, or the tests fail or cannot run there, the ticket goes to `needs_human` with the output, and no agent call is spent. This is also how a missing environment file on the default branch shows up. A failure here is final for the ticket, even a temporary one such as a Docker daemon that was down: add `rumba-retry` to try again. The check counts toward `minutes_per_ticket`.
2. `triaged`: the agent read the ticket and the repository and decided whether it is a bug or a feature, and whether Rumba can work it.
3. `criteria_ready`: the acceptance criteria are fixed. A bug gets one criterion derived from the report. A feature uses the criteria written on the ticket, in files it names, or in documents native to the tracker. Triage may mark a written criterion that is a constraint rather than a behaviour, such as "nothing calls the network", as not checkable, with a reason. Such a criterion keeps its wording, is listed in the pull request as not verified with that reason, and never counts as passed.
4. `awaiting_criteria`: a feature whose criteria are not written anywhere. Rumba never treats criteria it wrote itself as approved: it posts them as a draft and waits. Add `rumba-approved` to accept the draft as posted, or write the final criteria in the ticket description under an "Acceptance criteria" heading and then add the label.
5. `env_ready` → `checks_failing`: the environment is up at the base commit, the agent writes one check per criterion, and every check fails there, as it should.
6. `building` → `verified`: the agent changes the code on the branch `rumba/<name>/<ticket-id>` until every check passes, and the project's own tests too. Before each attempt the agent is told which checks pass, which fail, and whether only the project's tests failed. It may answer that no change is needed, with a reason; Rumba then verifies the code once more as it stands, and if it still does not pass, the ticket goes to `needs_human` with that reason.
7. `pr_open`: the pull request is open, with a summary of the change written by the agent, `Closes #<n>` for a GitHub issue (a link for Linear), and for each criterion the check's command, its file, and its result before and after the change. Criteria that no command can check are listed as not verified, and the pull request is then opened as a draft. Just before it opens the pull request, Rumba moves its checks into the project's own tests, as described below.

### Moving the checks into the project's tests

The agent writes its checks where it can find them, often in a folder of their own such as `tests/rumba/`. Once the change is verified, and before the pull request opens, Rumba has the agent move them into the repository's existing test layout: descriptive file and test names, merged into an existing test file where that is the natural place, imports fixed. They then arrive in the pull request as ordinary tests of the project. `checks.relocate: false` turns this off.

The move must not weaken a check, so Rumba keeps it only when both of these hold:

- **The lines are the ones it verified.** Rumba compares the moved files with the checks it verified, from the commits, line by line. Only three things may change, and only so far:
  - Imports, only in how they are written: every name a check imported must still be imported from the same module, as the same thing (a relative path may change with the file's place), and nothing else may be imported. Imports count only at the top of a file. A file with a star import (`from x import *`), or that defines at its top level a name the check imports, cannot take a check.
  - Test titles: the name given to `describe`, `it` or `test` (in single, double or backtick quotes, on the call's line or alone on the next one, and after the table of `test.each`), or the name of a `test_` function or `Test` class. In a template literal only the text may change: every `${...}` stays as written, in order. The call stays as it was, so `it.skip` is not `it`, and two Python tests may not end up with the same name.
  - Where a check sits: in a new test file, or at the end of an existing one, as one block, with every line and its indentation as written. Each file takes one check. A check merges into an existing file only when that file's top level holds nothing but tests, it has no hooks or mocks that would apply to it (`beforeEach`, `vi.mock`, fixtures and the like), imports nothing below its top, does not itself define a name the check imports, and was not changed by the fix; otherwise the agent makes a new file. The existing file keeps its own lines as they were.

  When the command picks tests by name (`-t`, `-k`, `-run`, a `::` test id and the like), the titles must stay as written too. No line may be added, and none of the lines at the top of the check or the file (comments, pragmas, `'use strict'`, a `package` clause) may be dropped. Only the files Rumba's checks added move: a check file that was already in the repository (a fixture an earlier ticket's checks left there, say) stays where it is, unchanged, since other tests may import it, and the moved check imports it from there. A check that imports another moved file, such as a shared fixture, imports it from its new place; no two moved files may answer to one module name, and a moved file may not take a module name another file already answers to (`helpers/factory.js` next to an existing `helpers/factory.ts`). The command must be the verified one with only the file paths changed, the check's files must be exactly its new places and the files that stayed, and those must be test files (a `.test.`/`.spec.` file, a `test_` or `_test` file, or a file in a test folder), never a file that sets up, configures or helps the tests: a file named like a test (`unsupported-blocks.test.ts`, `api-config.test.ts`) is always a test, while any other file is refused when its name holds `setup`, `config`, `teardown`, `helper`, `conftest` or `support` anywhere, and so is any file under `__mocks__`, `__fixtures__` or `support/`, and their paths must be plain (letters, digits, `.`, `_`, `-`, `+`, `@`), since they go into the command. Only the check files and their new places may change.
- **The moved checks still show the problem.** Rumba runs each moved check in the project's environment, in a fresh checkout, like any check: on the change, where it must pass (and the project's own tests with it, when `verify.test` is set), and on the base commit with the moved files on it, where it must fail. A check that cannot run does not count.

The line check catches a changed or dropped assertion, an added `return` or mock, a swapped import, a skipped or shadowed test, and a command that runs something else. What it cannot see is what the code under test does; the runs check that. Because a check goes into a file of its own or at the end of one with no hooks, and the fix did not touch that file, a failure on the base commit comes from the check itself.

If either fails, or the agent fails, Rumba undoes the move: the branch goes back to the verified change, with the checks as it wrote them, and the pull request opens anyway, saying in a "Checks" section why the move was rejected. If the move is kept, the evidence table shows each check's final command and file, notes where it was moved from, and keeps the result of the check Rumba wrote on the base commit as the "before". A moved check is judged by its new place for the scope warning, like any other change. A move that a crash interrupts is undone the same way, on the next run.

Every fix attempt is recorded in the state comment on the ticket: how each check did, whether the project's tests passed, failed or were stopped by the machine, and the last part of the output. A `fix_failed` comment lists the attempts one by one, so it can be explained from the ticket alone.

Exit states, each with a comment on the ticket:

| State | Meaning |
|---|---|
| `skipped` | Triage judged the ticket not workable by Rumba. |
| `not_reproducible` | A bug's check already passes on the base commit. |
| `needs_human` | The environment did not come up or the project's tests already failed on the default branch, a feature's checks already pass before any change, the time budget ran out, or the ticket hit three errors. |
| `fix_failed` | The checks, or the project's own tests, still fail after the allowed fix attempts. |

An unexpected error leaves the ticket at its last durable state and counts one error on it. A check or `verify.test` that could not execute (exit 126) or was not found (127) is such an error: it says nothing about the change, so it costs no fix attempt.

A verification that fails is run once more before the failure counts, in a fresh checkout and a fresh environment, so the code under test cannot pass the second time by leaving something behind the first time. If it died of the machine both times, that is an infrastructure error, not a fix attempt, and Rumba says so in a comment on the ticket. It counts as an error, so three errors on a ticket send it to `needs_human`. Because a failed verification runs twice, a slow test suite needs a `minutes_per_ticket` that leaves room for that. These count as the machine:
- Docker reports an out-of-memory kill in the project's containers.
- The command exits with 137 (SIGKILL) or timed out.
- The output shows a full disk (`ENOSPC`) or killed test workers.

The same holds on the base commit and in the environment check, where such a failure is never taken as evidence or as "the tests already fail". A run that dies partway leaves a lease, which the next run clears once it is older than `minutes_per_ticket` plus the environment's `command_timeout_minutes` plus 5 minutes; that also counts one error. A ticket that threw counts toward `max_tickets_per_run` like one that advanced.

`minutes_per_ticket` bounds the whole ticket. Each agent call and each environment command gets at most the time the ticket has left, and a call cut short by that ends the ticket in `needs_human` with the reason, not in an error. Taking the environment down is the exception: it always gets its full `command_timeout_minutes`, so a ticket that ran out of time leaves no containers running.

Rumba never merges. A person reviews and merges the pull request.

## Commands

| Command | What it does |
|---|---|
| `rumba run` | Runs every rumba in the repository, one after another. A rumba that fails is reported and the others still run. |
| `rumba run --name <name>` | Runs one rumba. |
| `rumba run --name <name> --ticket <id>` | Runs one ticket of one rumba. |
| `rumba status [--name <name>]` | Lists each opted-in ticket as `<rumba> <ticket> <state> <title>`. |
| `rumba init <name>` | Creates `.rumba/<name>/` and, if there is none, the workflow. |

`rumba run` prints one line per ticket, `<rumba> <ticket> <from> → <to>` or `<rumba> <ticket> left: <why>`. It exits with 1 on a config error, a missing key or any failure, and 0 otherwise.

Run it from anywhere inside a clone. Rumba reads the repository from `origin` and finds the default branch from `origin/HEAD`, or by asking `origin`.

## Config reference

One file per rumba, at `.rumba/<name>/rumba.yml`. Keys never go in this file.

```yaml
paths:                      # globs the rumba is expected to work in
  - apps/shop/**
tracker:
  kind: github              # github | linear
  # linear only: which tickets belong to this repository
  # team: ENG               # required for linear
  # project: Checkout       # optional
agent:
  kind: claude-code         # claude-code | gemini-cli
  model: claude-haiku-5-5   # optional; the agent's default if omitted
environment:
  kind: vercel-preview      # docker | vercel-preview
  # vercel-preview only:
  # project_id: prj_123     # optional; VERCEL_PROJECT_ID is used if omitted
  # docker only: run on the host, from a checkout of the default branch (see below)
  # up: docker compose up -d --wait
  # exec: docker compose exec -T app
  # down: docker compose down -v
  # command_timeout_minutes: 10   # the limit of each of up, exec and down
  # min_free_disk_gb: 5           # fail before up when Docker has less disk free; 0 skips the check
  # both: more files the agent may not change
  # protected: ["Makefile"]
verify:
  test: npm test            # optional: the project's own tests, run on the default branch first and against the change
checks:
  relocate: true            # optional: move Rumba's checks into the project's tests before the pull request
sandbox:
  node: 22                  # optional: the Node major version of the container the agent runs in
commit_author:              # optional: who Rumba's commits are made as (see below)
  name: Deploy Bot
  email: deploy-bot@example.com
limits:
  max_tickets_per_run: 3
  minutes_per_ticket: 30
  max_fix_attempts: 2
labels:                     # optional: rename the labels
  opt_in: rumba:shop
  state_prefix: "rumba-state:"
  approved: rumba-approved
  retry: rumba-retry
```

- `paths`: a change outside these globs is allowed, and listed in the pull request as outside scope.
- `tracker`: a Linear label is shared across a workspace, so a Linear tracker must name a team, and may name a project.
- `environment.docker`: the commands that bring the project up, run a command inside it, and take it down. Checks run through `exec`. See "The docker environment" below for where they run and what your compose file must do.
- `environment.vercel-preview`: Rumba pushes a throwaway branch `rumba/<name>/base-<ticket-id>` at the base commit and the fix branch, waits for each preview deployment, and runs the checks against it. It never runs checks against a production deployment. Checks can only see what is visible over HTTP or in a browser.
- `environment.protected`: globs of files the agent may not change. The docker default is the files that define the containers (`docker-compose*.y*ml`, `compose*.y*ml`, `Dockerfile*`, `*.dockerfile`, `.dockerignore`); the vercel-preview default is none. Setting the list replaces the default. Anything under `.rumba/` or `.github/`, and any file named `.env` at any depth, is always protected.
- `environment.command_timeout_minutes` (docker): the limit of each of `up`, `exec` and `down`, 10 minutes by default. A check or `verify.test` runs through `exec`, so a slow test suite needs a higher value. No command outlasts the ticket's time either, except `down`.
- `verify.test`: the project's own tests. Rumba runs them once on the default branch before any agent call, and against every fix.
- `checks.relocate`: whether Rumba moves its checks into the project's own test layout once the change is verified, `true` by default. See "Moving the checks into the project's tests" above. With `false`, the checks stay in the files the agent first wrote them in.
- `sandbox.node`: the Node major version (20 or later) of Rumba's sandbox image, the container the agent and the URL checks run in. Rumba always builds that image from its own Dockerfile, never from your repository; this setting only picks the Node version. The image has pnpm and yarn through corepack, at the version your `package.json` pins.
- `environment.min_free_disk_gb` (docker): before `up`, Rumba measures the disk Docker has left, from inside a tiny `busybox` container, and stops with "Not enough disk space for Docker" below this, 5 GB by default. This counts as an infrastructure error. 0 skips the check. When the measurement cannot run (no network to pull `busybox` the first time, say), the check is skipped.
- `commit_author`: who Rumba's commits are made as. `RUMBA_COMMIT_AUTHOR_NAME` and `RUMBA_COMMIT_AUTHOR_EMAIL`, set together, win over it. Without either, Rumba commits as the git identity of the clone it runs from: the `user.name` and `user.email` git would use there, from the clone's own config or your global one, when both are set. That is usually you, so integrations that check the commit author (a Vercel project that only builds commits by its members, say) recognise it as they recognise your own commits. The address goes into every commit Rumba pushes, as it does in yours; set `commit_author` to use another one. When the clone has no identity, Rumba commits as the GitHub account it runs as, with that account's `<id>+<login>@users.noreply.github.com` address, which Vercel may not match to your Vercel user; and when that account cannot be looked up, as `Rumba <rumba@users.noreply.github.com>`.
- `limits.minutes_per_ticket` bounds the whole ticket, as described above.

The `max_review_rounds` limit in the design belongs to stage 2 and is not read yet.

### The docker environment

`up`, `exec` and `down` are the only commands Rumba runs on your machine or CI runner for a project, and the code under test contains files an agent wrote. So Rumba never runs them in the code under test:

- Each command runs with its working directory in a fresh checkout of the default branch, at the commit the fix branch started from. Everything the command reads by relative path is therefore a file a person merged: the compose file and anything it includes or extends, `.env` and `env_file` entries, a Makefile, a `package.json` script, a shell script, a Dockerfile in the build context.
- Every command gets a checkout of its own: `up` runs in one, each `exec` in a new one, `down` in another. A folder that a container could have been given is never used to run a command again. Because the folder differs each time, Rumba sets `COMPOSE_PROJECT_NAME` to one name for all commands of a run, so compose finds its containers; do not pass `-p` or rely on the folder's name.
- The code under test is checked out in another directory. Rumba passes its path to the three commands in the `RUMBA_WORKDIR` environment variable, and in no other way.
- Your compose file must hand that path to the container. If it does not, the checks run against the default branch and the ticket ends in `fix_failed`.

The usual way is to mount it, with a fallback so the same file works when you run it by hand:

```yaml
services:
  app:
    build: .                      # the Dockerfile and build context of the default branch
    volumes:
      - ${RUMBA_WORKDIR:-.}:/app  # the code under test
    command: sleep infinity
```

A project that builds its code into the image can use the path as the build context, and keep the Dockerfile a person merged:

```yaml
services:
  app:
    build:
      context: ${RUMBA_WORKDIR:-.}
      dockerfile: ${PWD}/Dockerfile
```

Rules for whoever writes `rumba.yml` and the compose file:

- Give `RUMBA_WORKDIR` to Docker only, as a mount source or a build context. Never read or run anything under it on the host: no `sh "$RUMBA_WORKDIR/scripts/up.sh"`, no `env_file: ${RUMBA_WORKDIR}/.env`, no `--project-directory "$RUMBA_WORKDIR"`, no `-f "$RUMBA_WORKDIR/compose.yml"`.
- Mount `RUMBA_WORKDIR` itself, not a folder below it. A folder below it is a path the agent controls.
- `exec` must run its argument inside a container, as `docker compose exec -T <service>` does. Rumba runs every check and `verify.test` as `<exec> sh -c '<command>'`, so the container needs `sh`, and the command runs in the container's working directory. The agent is told this, and that it cannot run the checks in its own sandbox.
- `up` may call a script or `make`: it is the default branch's copy that runs.
- Do not give a container the folder the commands run in (`.` or a folder of it) to write to. Mount what you need from it read-only (`./nginx.conf:/etc/nginx/nginx.conf:ro`). `up` is the one command that runs while its own containers start, so if a container can write to that folder, it can change a file `up` has yet to read. When `up` returns, Rumba compares the folder with its commit, file by file; if anything was changed, added or removed, the run stops, the environment is taken down and the ticket counts an error. That also means `up` itself must not write into the folder it runs in.

## Environment variables

| Variable | Needed when |
|---|---|
| `RUMBA_GITHUB_TOKEN` | Always. Falls back to `GITHUB_TOKEN`. A fine-grained personal token or a GitHub App token with contents, issues and pull requests write access. |
| `GITHUB_TOKEN` | Used when `RUMBA_GITHUB_TOKEN` is not set. In Actions this is the workflow's own token. |
| `RUMBA_GITHUB_LOGIN` | Optional. The login of the account Rumba runs as. Set it when the token cannot look itself up (see below). In the workflow it is a repository variable, not a secret. |
| `ANTHROPIC_API_KEY` | The agent is `claude-code`, unless `CLAUDE_CODE_OAUTH_TOKEN` is set. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Instead of `ANTHROPIC_API_KEY`: a long-lived token from `claude setup-token`, which needs a Claude subscription. When both are set, Rumba passes only the API key, as Claude Code itself would prefer it. Either one is the only credential the agent container gets. |
| `GEMINI_API_KEY` | The agent is `gemini-cli`. |
| `LINEAR_API_KEY` | The tracker is `linear`. |
| `VERCEL_TOKEN` | The environment is `vercel-preview`. |
| `VERCEL_PROJECT_ID` | The environment is `vercel-preview` and `rumba.yml` sets no `environment.project_id`. |
| `VERCEL_TEAM_ID` | Optional, for a project owned by a Vercel team. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional, for protected previews. It is given to the check container. |
| `RUMBA_COMMIT_AUTHOR_NAME`, `RUMBA_COMMIT_AUTHOR_EMAIL` | Optional, together: who Rumba's commits are made as. They win over `commit_author` in `rumba.yml`. |
| `RUMBA_HOME` | Optional. Rumba's folder for the environment lock and the records of each run. Default: `$XDG_CACHE_HOME/rumba`, or `~/.cache/rumba`. |

A missing key fails that rumba with a message naming the variable and why the rumba needs it.

## After a run

Every agent call leaves a record: which task and attempt it was, the agent's result with its summary, and the last 20,000 characters of what it printed, or the error it ended with. The records are kept under `<RUMBA_HOME>/runs/<run id>/<ticket>/`, one file per call, such as `03-fix-attempt-2.md`, readable only by your user, with every key Rumba knows replaced by `[redacted]`. `rumba run` prints the folder at the end of each rumba's run.

## One environment at a time

Docker environments on one machine compete for its memory and disk. A test suite run by two environments at once can make Docker's out-of-memory killer fail a correct fix. So a Rumba process holds a lock file, `<RUMBA_HOME>/environment.lock`, from before `up` until after `down`, and another Rumba process on the same machine waits for it. The wait counts toward the ticket's time. The lock holds the process id of its owner and is removed when that process releases it or exits. A lock left by a process that is gone, after a crash or a `kill -9`, is taken over, and so is a lock file nobody can read once it is a few seconds old. Waiting longer than the ticket's time counts as an infrastructure error. Processes on other machines, or in other containers, are not covered.

Pull requests opened with the default GitHub Actions token do not start the repository's own CI. Set `RUMBA_GITHUB_TOKEN` to a fine-grained token or a GitHub App token to get CI on Rumba's pull requests.

## Security

Ticket text, and anything the agent reads, is untrusted input, and the coding agent has a shell. Rumba is built around that:

- Only people who can label tickets can opt a ticket in or approve criteria.
- The agent runs in a throwaway container with only the working copy of the fix branch mounted. That container gets one model credential, the API key or the Claude Code token, and nothing else. Tracker, GitHub and Vercel tokens stay in the Rumba process, which does the pushing and commenting itself.
- The container has network access, because the agent must reach its model and install packages. Restricting it is not part of stage 1.
- A check container gets only what the check needs, such as the preview URL and the Vercel bypass secret. Rumba replaces known secret values with `[redacted]` in check output and error messages before posting or printing them. It keeps at most the last 4,000 characters of each check's output, less when a ticket has several checks, and drops the output altogether if the ticket comment or pull request body would otherwise be too long for the tracker.
- The agent may not change anything under `.rumba/` or `.github/`, any file named `.env`, or any path in `environment.protected`. A change there fails verification.
- What runs on the host, and what it reads. Rumba starts three kinds of process on the host: the docker environment's `up`, `exec` and `down`, `docker`, and `git`.
  - `up`, `exec` and `down` never run in a folder an agent wrote to, and get the code under test only as a path in `RUMBA_WORKDIR`. Each runs in a checkout of the default branch made for that one command. So the files `exec` and `down` read by relative path (compose files and what they include, `.env`, a Makefile, a script) are files a person merged, and no container existed that could have been given that folder. The same holds for `up`, with one exception: `up` starts containers, and if the merged compose file gives one of them the folder `up` runs in to write to, code in that container can change a file before `up` reads it. Rumba cannot prevent that. It notices when the folder no longer matches its commit once `up` returns, and stops the run.
  - The code under test reaches a container as a mount or as a build context, and nothing else. The protected paths are a second layer, not the boundary.
  - `docker` is given a folder an agent wrote to as a mount source, or as a build context if the compose file says so. It does not read configuration from it.
  - `git` does read the agent's files: it must, to commit them and to check the commit out. It reads them as content, never as configuration or as a list of what to run. Rumba names the repository explicitly, runs no hooks, and refuses a working copy that holds another git repository before git can enter it. No filter, diff or merge driver runs on those files: git attributes are taken from nowhere in the working copy or the commit, no attributes file of the user is read, the user's and the system's git config are not read by the commands that read or check out those files, and every filter driver in the repository's own git config is switched off for them.
  - The Rumba process itself reads one file from the agent's working copy: the agent's result, `.rumba-out/result.json`. It is read as data, only if it is a regular file in a regular folder, and checked against a fixed shape. It also reads the files a check names, to hash them, and the text of symbolic links, without following them.
  - Rumba deletes a checkout with a walk that cannot be led outside it, even if a container that did not stop is still writing to it. If a checkout cannot be deleted, it is left in the temporary folder.
- What this does not cover:
  - A compose file or `rumba.yml` that breaks the rules in "The docker environment" above. Rumba cannot check them.
  - Code in the project's container. It is the agent's code, and it has whatever the compose file gives that container.
  - Git filter drivers do not run in Rumba's checkouts at all. In a repository that uses Git LFS, the agent, the checks and the host commands see LFS pointer files, not the real files, and line-ending conversion from `.gitattributes` is not applied.
  - If `down` cannot run, because no checkout could be made for it or the command fails, the project's containers keep running.
- After each agent call Rumba commits the change, checks the commit against the protected paths, and removes the agent's working copy. The commit under test is then checked out fresh, so a file the agent left out of the commit, such as a git-ignored `.env`, is not there. Each checkout sits alone in its own temporary folder.
- Rumba refuses to commit a git repository inside the repository, or a symbolic link that really leads outside it, whichever links it passes through on the way.
- Rumba reads state only from comments written by the account it runs as. Changing the token to one of another account makes open tickets start again from `queued`.
- When Rumba runs with the Actions token and cannot look up its own login, set the repository variable `RUMBA_GITHUB_LOGIN` to `github-actions[bot]`. Without a known login Rumba stops with an error rather than trust comments from any account.
- Do not run Rumba as root. The sandbox runs as the calling user, and Claude Code refuses to run without permission prompts as root.
- Rumba never merges a pull request.

## Contributing

Changes come as pull requests against `main`, with tests written first and `npx vitest run`, `npm run typecheck`, `npm run build` and `npm run test:e2e` passing.

### Examples and privacy

This repository is public. Every example in code, tests, comments, docs, commit messages and pull requests must be invented, never taken from a real project: no company, client, product, project or repository names, no ticket numbers, no file names, folder layouts, test titles or paths copied from a real codebase, and no email addresses or local paths. Use generic stand-ins instead, such as an "orders" or "widgets" domain, `tests/widgets/import.test.ts`, "ticket #42", "the project" or "a live run". When a bug found in a real project needs a test, rebuild the case with invented content that exercises the same thing.

## Licence

MIT
