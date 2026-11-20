# Rumba

Rumba is an open-source tool that picks up labelled tickets from an issue tracker and takes each one to a pull request. It only opens the pull request after it has evidence: checks that fail on the current code and pass on the change.

## Status

This is stage 1: Rumba takes a ticket from its label to an open pull request. What is not done yet:

- The package is not published to npm. `npx rumba-cli` and the generated workflow will work once it is; until then, build it from this repository (`npm install && npm run build`, then `node dist/cli.js` or `npm link`).
- The sandbox image (`rumba-sandbox:local`) is not pushed to any registry. Rumba builds it locally from `sandbox/Dockerfile` the first time `rumba run` needs it, which takes a few minutes.
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
rumba init hub
```

This creates:

- `.rumba/hub/rumba.yml`: the rumba's config (see below). The starter file uses the GitHub tracker, the Claude Code agent and a Docker environment; edit it to match your project.
- `.rumba/hub/context.md`: what the agent should know about this area of the code. Written by people.
- `.rumba/hub/lessons.md`: lessons from earlier tickets. Edited by hand in stage 1.
- `.github/workflows/rumba.yml`, if it does not exist: a workflow that runs every 30 minutes and on demand, one job per rumba. Each later `rumba init <name>` adds the new name to its matrix. If the file exists and was not written by `rumba init`, add the name by hand.

Then add the keys the rumba needs as repository secrets (see [Environment variables](#environment-variables)) and commit the files.

Before you enable the workflow:

- `rumba-cli` is not published to npm yet, and until the name is taken anyone could publish a package under it. The workflow's `npx rumba-cli run` step is ready for when it is. Until then, do not enable the workflow, or replace that step with an install from a checkout of Rumba you trust.
- With the default Actions token, turn on the repository setting "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General). Without it, opening the pull request fails after all the work is done.
- Keep the checkout step's stored credentials, which is the default: do not set `persist-credentials: false`. Rumba fetches the default branch with them.

A rumba name uses lowercase letters, digits and hyphens. It is the folder name under `.rumba/`, and a repository can have several rumbas, each with its own scope, agent, model and environment.

## How a ticket moves

Labels are the interface. Rumba creates the labels it manages the first time it runs.

| Label | Added by | Meaning |
|---|---|---|
| `rumba:<name>` | a person | Opts the ticket in to that rumba. A ticket with two of them is taken by none, and Rumba says so once. |
| `rumba-state:<state>` | Rumba | The ticket's current state. Exactly one at a time. |
| `rumba-approved` | a person | Accepts the acceptance criteria Rumba drafted. |
| `rumba-retry` | a person | Starts a ticket at an end state, or with an open pull request, again from `queued`. |

Rumba also keeps one state comment on the ticket, which it edits in place, and posts one comment for each exit saying why.

On each run Rumba takes each opted-in ticket as far as it can:

1. `queued`: the ticket has the opt-in label and no state yet.
2. `triaged`: the agent read the ticket and the repository and decided whether it is a bug or a feature, and whether Rumba can work it.
3. `criteria_ready`: the acceptance criteria are fixed. A bug gets one criterion derived from the report. A feature uses the criteria written on the ticket, in files it names, or in documents native to the tracker.
4. `awaiting_criteria`: a feature whose criteria are not written anywhere. Rumba never treats criteria it wrote itself as approved: it posts them as a draft and waits. Add `rumba-approved` to accept the draft as posted, or write the final criteria in the ticket description under an "Acceptance criteria" heading and then add the label.
5. `env_ready` → `checks_failing`: the environment is up at the base commit, the agent writes one check per criterion, and every check fails there, as it should.
6. `building` → `verified`: the agent changes the code on the branch `rumba/<name>/<ticket-id>` until every check passes.
7. `pr_open`: the pull request is open, with the before and after results of each check. Criteria that no command can check are listed as not verified, and the pull request is then opened as a draft.

Exit states, each with a comment on the ticket:

| State | Meaning |
|---|---|
| `skipped` | Triage judged the ticket not workable by Rumba. |
| `not_reproducible` | A bug's check already passes on the base commit. |
| `needs_human` | A feature's checks already pass before any change, a time budget ran out, or the ticket hit three errors. |
| `fix_failed` | The checks still fail after the allowed fix attempts. |

An unexpected error leaves the ticket at its last durable state and counts one error on it. A run that dies partway leaves a lease that the next run clears once it is older than `minutes_per_ticket`; that also counts one error. A ticket that threw counts toward `max_tickets_per_run` like one that advanced.

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
  - apps/hub/**
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
  # both: more files the agent may not change
  # protected: ["Makefile"]
verify:
  test: npm test            # optional: the project's own tests, run against the change
limits:
  max_tickets_per_run: 3
  minutes_per_ticket: 30
  max_fix_attempts: 2
labels:                     # optional: rename the labels
  opt_in: rumba:hub
  state_prefix: "rumba-state:"
  approved: rumba-approved
  retry: rumba-retry
```

- `paths`: a change outside these globs is allowed, and listed in the pull request as outside scope.
- `tracker`: a Linear label is shared across a workspace, so a Linear tracker must name a team, and may name a project.
- `environment.docker`: the commands that bring the project up, run a command inside it, and take it down. Checks run through `exec`. See "The docker environment" below for where they run and what your compose file must do.
- `environment.vercel-preview`: Rumba pushes a throwaway branch `rumba/<name>/base-<ticket-id>` at the base commit and the fix branch, waits for each preview deployment, and runs the checks against it. It never runs checks against a production deployment. Checks can only see what is visible over HTTP or in a browser.
- `environment.protected`: globs of files the agent may not change. The docker default is the files that define the containers (`docker-compose*.y*ml`, `compose*.y*ml`, `Dockerfile*`, `*.dockerfile`, `.dockerignore`); the vercel-preview default is none. Setting the list replaces the default. Anything under `.rumba/` or `.github/`, and any file named `.env` at any depth, is always protected.
- `limits.minutes_per_ticket` is also the time limit of each agent call.

The `max_review_rounds` limit in the design belongs to stage 2 and is not read yet.

### The docker environment

`up`, `exec` and `down` are the only commands Rumba runs on your machine or CI runner for a project, and the code under test contains files an agent wrote. So Rumba never runs them in the code under test:

- Each command runs with its working directory in a fresh checkout of the default branch, at the commit the fix branch started from. Everything the command reads by relative path is therefore a file a person merged: the compose file and anything it includes or extends, `.env` and `env_file` entries, a Makefile, a `package.json` script, a shell script, a Dockerfile in the build context.
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
- `exec` must run its argument inside a container, as `docker compose exec -T <service>` does. Checks and `verify.test` are passed to it.
- `up` may call a script or `make`: it is the default branch's copy that runs.
- A change to the compose files or a Dockerfile in a fix is rejected, because the environment is built from the default branch's copies and could not show that such a change works. Make those changes by hand.

## Environment variables

| Variable | Needed when |
|---|---|
| `RUMBA_GITHUB_TOKEN` | Always. Falls back to `GITHUB_TOKEN`. A fine-grained personal token or a GitHub App token with contents, issues and pull requests write access. |
| `GITHUB_TOKEN` | Used when `RUMBA_GITHUB_TOKEN` is not set. In Actions this is the workflow's own token. |
| `RUMBA_GITHUB_LOGIN` | Optional. The login of the account Rumba runs as. Set it when the token cannot look itself up (see below). In the workflow it is a repository variable, not a secret. |
| `ANTHROPIC_API_KEY` | The agent is `claude-code`. |
| `GEMINI_API_KEY` | The agent is `gemini-cli`. |
| `LINEAR_API_KEY` | The tracker is `linear`. |
| `VERCEL_TOKEN` | The environment is `vercel-preview`. |
| `VERCEL_PROJECT_ID` | The environment is `vercel-preview` and `rumba.yml` sets no `environment.project_id`. |
| `VERCEL_TEAM_ID` | Optional, for a project owned by a Vercel team. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | Optional, for protected previews. It is given to the check container. |

A missing key fails that rumba with a message naming the variable and why the rumba needs it.

Pull requests opened with the default GitHub Actions token do not start the repository's own CI. Set `RUMBA_GITHUB_TOKEN` to a fine-grained token or a GitHub App token to get CI on Rumba's pull requests.

## Security

Ticket text, and anything the agent reads, is untrusted input, and the coding agent has a shell. Rumba is built around that:

- Only people who can label tickets can opt a ticket in or approve criteria.
- The agent runs in a throwaway container with only the working copy of the fix branch mounted. That container gets the model key and nothing else. Tracker, GitHub and Vercel tokens stay in the Rumba process, which does the pushing and commenting itself.
- The container has network access, because the agent must reach its model and install packages. Restricting it is not part of stage 1.
- A check container gets only what the check needs, such as the preview URL and the Vercel bypass secret. Rumba replaces known secret values with `[redacted]` in check output and error messages before posting or printing them. It keeps at most the last 4,000 characters of each check's output, less when a ticket has several checks, and drops the output altogether if the ticket comment or pull request body would otherwise be too long for the tracker.
- The agent may not change anything under `.rumba/` or `.github/`, any file named `.env`, or any path in `environment.protected`. A change there fails verification. Rumba also refuses to commit a symbolic link the agent added that points outside the repository.
- No file an agent wrote is read or run by a command Rumba starts on the host. After each agent call Rumba commits the change, checks the commit against the protected paths, and removes the agent's working copy. The commit under test is then checked out fresh, so a file the agent left out of the commit, such as a git-ignored `.env`, is not there. With the docker environment, `up`, `exec` and `down` run in a separate checkout of the default branch and only receive the path of the commit under test, in `RUMBA_WORKDIR`; the code under test reaches a container as a mount or a build context and nothing else. The protected paths are a second layer, not the boundary. This holds only while `rumba.yml` and the compose file follow the rules in "The docker environment" above.
- The one file the Rumba process reads from the agent's working copy is the agent's result, `.rumba-out/result.json`. It is read as data, only if it is a regular file in a regular folder, and checked against a fixed shape.
- Rumba reads state only from comments written by the account it runs as. Changing the token to one of another account makes open tickets start again from `queued`.
- When Rumba runs with the Actions token and cannot look up its own login, set the repository variable `RUMBA_GITHUB_LOGIN` to `github-actions[bot]`. Without a known login Rumba stops with an error rather than trust comments from any account.
- Do not run Rumba as root. The sandbox runs as the calling user, and Claude Code refuses to run without permission prompts as root.
- Rumba never merges a pull request.

## Licence

MIT
