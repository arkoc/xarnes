# xarnes-agent

**~600 lines. One-click deployment. Full control. Your custom skills.**

`xarnes-agent` is a small, self-hosted pull-request review runner. It watches your GitHub repository
and uses [OpenAI Codex](https://learn.chatgpt.com/docs) to run your configured skill on each eligible
PR. Your skill chooses the checks, verdict, and complete review body. The runner posts the result:
`pass` approves, `comment` comments, and `block` requests changes.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/arkoc/xarnes)

## Why xarnes-agent

- **Easy to verify.** The whole runner is one [~600-line file](agent.mjs) using only Node.js built-ins.
  Read it end to end to see how credentials, reviews, retries, and delivery work.
- **Host it yourself.** Deploy to your Render account with one click, or run Docker on your own
  infrastructure. Your persistent volume holds the sign-ins, queue, and results.
- **Full control.** Choose the repository, branches, model, concurrency, and reviewer identity.
  Inspect and change the source, configuration, and saved state.
- **Your custom skills.** Set `SKILL` to a skill in your repository. It defines the review policy
  and the Markdown body to post; the runner handles execution, retries, and GitHub delivery.

## Deploy to Render

Click **Deploy to Render** and provide the four required environment values:

| Field | Value |
|---|---|
| `GITHUB_REPO` | `owner/name` of the repository to watch |
| `SKILL` | Directory in that repository holding `SKILL.md`, for example `skills/review` |
| `GITHUB_TOKEN` | Fine-grained token with **Contents: read**, **Pull requests: write**, **Commit statuses: write** |
| `STATUS_CONTEXT` | Review/check name, for example `security-review`. GitHub displays `security-review/pr-123` for PR #123 |

All optional watcher settings are declared in [render.yaml](render.yaml) and applied automatically.
Open your service's **Environment** page to see all 19 settings, including these defaults:

| Optional setting | Render default |
|---|---|
| `TARGET_BRANCHES` | `main` |
| `MAX_CONCURRENCY` | `1` |
| `MAX_ATTEMPTS` | `3` |
| `POLL_SECONDS` | `15` |
| `RUN_EXISTING` | `false` |
| `WATCH_UPDATES` | `true` |
| `MODEL` | `gpt-6-astra` |
| `FAST_MODE` | `true` |
| `TASK_TIMEOUT_SECONDS` | `1800` |
| `SANDBOX` | `container` |
| `ALLOW_NETWORK` | `false` |
| `DATA_DIR` | `/data` |
| `CODEX_HOME` | `/data/codex` |
| `CODEX_BIN` | `codex` |
| `GITHUB_TOKEN_FILE` | empty (use `GITHUB_TOKEN`) |

Render's creation form prompts only for the four required values. To change optional settings
permanently, edit your fork's `render.yaml`: a later Blueprint sync can overwrite changes made on
the Environment page. Settings used only by local task mode are listed under Configuration below.

Codex uses your ChatGPT account. On first start, follow the sign-in link and code in the logs for
each configured slot. Sign-ins run one at a time; polling starts after all slots are authenticated.
No shell access is needed.

The [Render blueprint](render.yaml) builds the Dockerfile as a background worker with a persistent
1 GB disk at `/data`. The GitHub token and saved Codex sign-in live on your Render service.

If you fork this repository, update the button above to point to your fork.
Render builds directly from the repository; no published image is required.

## How it works

```
 every 15 s ─► list open PRs ─► keep non-draft PRs into TARGET_BRANCHES ─► queue new heads
                                                                                │
                              ┌─────────────────────────────────────────────────┘
                              ▼   (up to MAX_CONCURRENCY at once, one Codex sign-in each)
   fetch HEAD + target ─► merge-base = BASE ─► checkout HEAD, worktree BASE ─► load skill from BASE
                              │
                              ▼
   codex exec  ◄── skill path, repo, PR number, BASE, HEAD, PR metadata file
                              │  returns JSON: verdict, body
                              ▼
   validate ─► save result + marker ─► recheck PR ─► POST review ─► commit status
```

1. **Discover.** Every `POLL_SECONDS` the agent lists open pull requests and keeps the non-draft
   ones targeting `TARGET_BRANCHES`. A PR is queued when it is new, has a new head commit, or was
   retargeted. Discovery keeps running while reviews are in progress, so new work is never blocked
   behind a long review, and a finished review wakes the next scan immediately.
2. **Prepare.** For each queued PR the agent fetches the exact head and target commits, computes the
   merge base, checks out the head, and creates a second worktree at the merge base. The skill is
   loaded **from the merge base**, never from the PR, so a PR that edits the skill still gets
   reviewed by the skill the target branch had.
3. **Review.** Codex runs non-interactively in its own process group and Codex home, starting
   outside both checkouts with user configuration, rules, and `AGENTS.md` loading disabled. It
   receives the skill path, repository, PR number, `BASE`, `HEAD`, and a metadata file with the PR
   title and description, which the prompt marks as untrusted data. It never receives the GitHub
   token.
4. **Validate.** The response must be a JSON object with a verdict of `pass`, `comment`, or `block`,
   and a non-empty `body` string. The skill decides the verdict and writes the complete review.
   Nothing is posted for a malformed result.
5. **Deliver.** The validated result is saved to the volume with a unique marker **before** anything
   is posted. The agent then re-reads the PR (still open, same head, same base, not a draft),
   submits the review bound to the reviewed commit, and updates the commit status. If the response
   is lost, the next scan finds the marker on GitHub and does not post again.
6. **Retry.** Failed review execution uses backoff (5, 10, 20, 40 minutes, capped at 60) until
   `MAX_ATTEMPTS` is spent. Interrupted runs retry on restart when attempts remain; a graceful
   stop does not consume an attempt. GitHub delivery failures retry the saved result without
   rerunning Codex or consuming review attempts.

## What developers see

A commit status named `<STATUS_CONTEXT>/pr-<number>` tracks review progress:

| Stage | Status |
|---|---|
| Waiting for a worker | 🟡 Pending: Queued for review |
| Picked up by a worker | 🟡 Pending: Review running (attempt n/N) |
| Review finished, delivery pending | 🟡 Pending: Review finished; posting the result |
| Result `pass` | ✅ Success: Review passed |
| Result `comment` | ✅ Success: Review complete with non-blocking comments |
| Result `block` | ❌ Failure: Review blocked; changes requested |
| Retry scheduled | 🟡 Pending: Review failed; retry scheduled |
| Retry budget exhausted | ⚠️ Error: operator action needed |
| Superseded revision or closed PR | ⚠️ Error: superseded or cancelled |

The skill writes the complete review body, including any headings, icons, tables, evidence, and
commit references. The runner posts it with credential redaction and a hidden delivery marker,
without adding visible formatting.

These statuses are informational: their names include the PR number, so they cannot serve as one
reusable required status check for the branch. To gate merging on reviews, configure required
approvals and **dismiss stale approvals** in your branch rules. GitHub does not let a token approve
its owner's own PRs, so use a dedicated reviewer identity.

## Run it yourself

```sh
docker build -t xarnes-agent:local .
cp agent.env.example agent.env   # set GITHUB_REPO, SKILL, GITHUB_TOKEN, STATUS_CONTEXT
chmod 600 agent.env
```

Sign in once, or skip this and follow the link the watcher prints on first start:

```sh
docker run --rm -it --no-healthcheck --env-file ./agent.env -v my-agent:/data xarnes-agent:local login
```

Watch:

```sh
docker run -d --name pr-agent --stop-timeout 15 --restart unless-stopped \
  --log-driver local --log-opt max-size=10m --log-opt max-file=3 \
  --env-file ./agent.env -v my-agent:/data xarnes-agent:local watch

docker logs -f pr-agent
```

Reuse the same volume on every run: it holds the sign-in, the state file, and the saved results.
Run exactly one watcher per volume; the container holds a lock on it and refuses a second owner.
With `MAX_CONCURRENCY=N`, each slot has its own Codex home (`/data/codex`, `/data/codex-2`, …) and
its own sign-in; `login` signs in every slot that lacks one, `login 2` re-signs one slot. Slots
signed in with the same ChatGPT account share its rate limit, so concurrency buys wall-clock time,
not quota.

One-off run against a local checkout, without GitHub (no review is posted):

```sh
docker run --rm -v my-agent:/data -v "$PWD:/workspace" -e SKILL=skills/review xarnes-agent:local task
```

Task mode runs the explicitly configured `SKILL`. For a free-form task, set `INSTRUCTIONS` or
`INSTRUCTIONS_FILE` (see [instructions.example.md](instructions.example.md)) and leave `SKILL` unset.
Any edits remain in the mounted workspace.

## Configuration

Everything is an environment variable. `agent.env.example` is a commented starting point.
The table lists the runner's defaults when variables are absent. The Render blueprint and local
example explicitly select `gpt-6-astra` with `FAST_MODE=true`.

| Variable | Default | Purpose |
|---|---|---|
| `GITHUB_REPO` | required | Repository to watch, `owner/name`. Its presence selects `watch` when no command is given |
| `SKILL` | required | Skill directory in that repository; a bare name means `skills/<name>` |
| `GITHUB_TOKEN` / `GITHUB_TOKEN_FILE` | required | GitHub credential; the file form takes precedence |
| `TARGET_BRANCHES` | `main` | Comma-separated base branches; only non-draft PRs into these are reviewed |
| `STATUS_CONTEXT` | required | Commit-status check name; the agent appends `/pr-<number>` |
| `MAX_CONCURRENCY` | `1` | Reviews run in parallel, one Codex sign-in each |
| `MAX_ATTEMPTS` | `3` | Attempts per head commit before the failure becomes terminal |
| `POLL_SECONDS` | `15` | Discovery interval and minimum delivery-retry delay; integer ≥ 15 |
| `RUN_EXISTING` | `false` | Also review PRs already open on the first scan |
| `WATCH_UPDATES` | `true` | Review new head commits on already-reviewed PRs |
| `MODEL` | Codex default | Codex model override |
| `FAST_MODE` | `false` | `true` requests Codex's Fast tier (more ChatGPT credits, if available for the model) |
| `TASK_TIMEOUT_SECONDS` | `1800` | Limit for one Codex run; the whole process group is killed on expiry |
| `SANDBOX` | `container` in the image | `container` trusts the container boundary; `read-only` / `workspace-write` use Codex's inner sandbox |
| `ALLOW_NETWORK` | `false` | Network access for skill commands in `workspace-write` mode |
| `DATA_DIR` | `/data` | Volume root: sign-ins, state, results, checkouts |
| `CODEX_HOME` | `$DATA_DIR/codex` | Slot 1's Codex home; slot N uses `<CODEX_HOME>-N` |
| `CODEX_BIN` | `codex` | Codex executable |
| `WORKSPACE` | `/workspace` | Task mode: the checkout to run against |
| `SKILLS_DIR` | `$WORKSPACE/skills` | Task mode: where bare skill names are resolved |
| `INSTRUCTIONS` / `INSTRUCTIONS_FILE` | none | Task mode: free-form prompt instead of a skill |

Credentials are read at startup; restart after rotating them. The image runs as the non-root `node`
user and pins its Node base image by digest and the Codex CLI by version.

## The skill contract

Configure `SKILL` with the directory of the skill you want the runner to execute, for example
`SKILL=skills/your-review`. That directory must contain `SKILL.md` and any references it needs,
committed to the repository being reviewed. Your configured skill owns the review policy, the
verdict, and the complete review body.
Its final response must be a JSON object with two required fields, without Markdown fences or
surrounding text:

```json
{
  "verdict": "block",
  "body": "## Changes requested\n\nThe endpoint allows anonymous writes. Restore the authorization check."
}
```

- `verdict`: exactly `pass`, `comment`, or `block`.
- `body`: a non-empty string containing the complete GitHub review in Markdown.

| Verdict | GitHub review | Commit status |
|---|---|---|
| `pass` | `APPROVE` | success |
| `comment` | `COMMENT` | success |
| `block` | `REQUEST_CHANGES` | failure |

These are the only required fields. Extra fields are ignored. The runner validates the verdict
and body, then posts the skill's Markdown using the matching GitHub review action.

The runner posts `body` with credential redaction and a hidden marker for duplicate prevention.
The JSON response is saved under `/data/runs/*.json`. The runner's 60,000-byte publishing limit
includes the marker; oversized reviews fail rather than truncate. Skills should keep their bodies
below this limit.

## Reliability notes

- **State** lives in `/data/prs-OWNER--REPO.json`: per PR the reviewed head, base, attempt count,
  result path, marker, and delivered review id. Writes are fsynced and atomically renamed. Invalid
  state stops startup without changing the file. Closed PRs retain completed and pending review
  records so reopening can reuse a saved result or recognize an already-posted review. Other
  closed-PR records are removed.
- **Concurrency is one process.** Workers share the process; the state file and GitHub status
  writes are serialized; a PR never has two reviews in flight, so a new head on an active PR waits.
- **Healthcheck** (`node /app/agent.mjs healthcheck`) is a liveness check: the discovery loop ticked
  within `max(2 min, 3 × POLL_SECONDS)`. A failing GitHub scan logs `Poll failed` but is not
  "unhealthy", because a restart would not fix it.
- **Shutdown** on `SIGTERM` aborts GitHub calls, signals every Codex process group, escalates to
  `SIGKILL` after five seconds, and marks interrupted runs for immediate retry without spending an
  attempt. Allow at least 15 seconds for graceful shutdown.
- **Storage:** `codex[-N]/` holds sign-ins, `runs/` saved results, `prs-*.json` watcher state, and
  `agent.lock` the single-owner lock. Each review uses temporary checkouts under `workspaces/`;
  both snapshots and their Git history are removed after success or failure. Startup clears any
  checkouts left by a crash. Saved results have no automatic expiry. Allow space for
  `MAX_CONCURRENCY × (repository history + two working trees)`, plus saved results and Codex data.

## Security notes

The skill loaded from the merge base cannot be replaced by the PR under review; symlinks in the skill
directory are rejected. Codex workers do not receive the GitHub token; only the wrapper fetches and
publishes. Review bodies and logs are scrubbed of known token shapes and of every secret the agent
loaded. That said, the default `SANDBOX=container` trusts the container as the boundary: skill
commands run as the same user as the wrapper, with the volume and network reachable. Use this for
repositories you control. Reviewing hostile or public pull requests needs workers isolated from the
publisher and its credentials.

## Repository layout

| File | What it is |
|---|---|
| [`agent.mjs`](agent.mjs) | The runner. Everything described above |
| [`Dockerfile`](Dockerfile) | Node + Git + Codex CLI, non-root, `tini` + `flock` entrypoint |
| [`agent.env.example`](agent.env.example) | Commented configuration template |
| [`render.yaml`](render.yaml) | Deploy to Render blueprint |
| [`.github/workflows/publish.yml`](.github/workflows/publish.yml) | Builds and publishes the image to GHCR |
| `*.test.mjs` | Tests: local Git fixtures, a fake Codex, a mocked GitHub API. No network, no credentials |

## Tests

```sh
node --test --test-timeout=120000 agent.test.mjs reviews.test.mjs lifecycle.test.mjs status.test.mjs
```

Tests cover the verdict mapping, skill-written bodies, delivery reconciliation across restarts and
lost responses, retries and backoff, concurrency, queue persistence, status transitions, shutdown,
crash recovery, state validation, and first-start sign-in from the logs. They use temporary
directories and mocked services; no network or credentials are needed.

References: [Codex documentation](https://learn.chatgpt.com/docs),
[skills](https://learn.chatgpt.com/docs/build-skills),
[GitHub reviews API](https://docs.github.com/en/rest/pulls/reviews),
[GitHub commit statuses](https://docs.github.com/en/rest/commits/statuses).
