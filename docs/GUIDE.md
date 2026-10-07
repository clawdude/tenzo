# Guide

Everything about running Tenzo: the daemon and its settings, the CLI, project config, automations, and upgrading. Phones and pairing are in [REMOTE.md](REMOTE.md); how it works inside is in [ARCHITECTURE.md](ARCHITECTURE.md).

## The daemon

```bash
pnpm build          # the web app, into apps/web/build
pnpm tenzo serve    # daemon + web app on http://127.0.0.1:4780
```

`pnpm tenzo <command>` runs `apps/daemon/src/cli.ts` on Node's type stripping, with no build step. The file is executable and is the package's `tenzo` bin, so a symlink to it on your `PATH` gives you a bare `tenzo`.

The daemon listens on loopback only. Its main listener serves the web app, `GET /health` (version and environment id), `POST /api/commands` and the WebSocket at `/ws`. A second listener on `TENZO_LIVE_PORT` serves only threads' live apps (`/live/`), on an origin of its own. One daemon runs per `TENZO_HOME`.

### Settings

The daemon reads these once at start (`apps/daemon/src/config.ts`, which refuses nonsense loudly), except `TENZO_CLAUDE_PATH`, looked up at each session start.

| Variable | Default | |
|---|---|---|
| `TENZO_PORT` | `4780` | port to listen on, and where the CLI finds the daemon |
| `TENZO_LIVE_PORT` | `TENZO_PORT` + 1 | the live listener's port |
| `TENZO_LIVE_ORIGIN` | none | the live listener's public origins, comma-separated (e.g. `https://my-mac.tailnet.ts.net:8444`); Open live links to the one on the host name you reached Tenzo by, else to the live port on that name |
| `TENZO_HOME` | `~/.tenzo` | Tenzo's state (below) |
| `TENZO_WEB_DIR` | `apps/web/build` | the built web app to serve |
| `TENZO_ALLOWED_HOSTS` | none | host names besides loopback that may reach the daemon, comma-separated (e.g. the Tailscale Serve name). Others get 403 |
| `TENZO_PUBLIC_URL` | none | where devices elsewhere reach Tenzo, port included (`https://my-mac.tailnet.ts.net:8443`): the host of `tenzo pair`'s links. Unset, `tenzo pair` needs `--url` |
| `TENZO_DEV_ORIGIN` | none (`pnpm dev` sets Vite's) | dev-server origins whose pages may use the API and `/ws`, comma-separated |
| `TENZO_CLAUDE_PATH` | found | the `claude` threads run: the first on `PATH`, else `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` or `/usr/local/bin` |
| `TENZO_DEFAULT_MODEL` | Claude's own | the model for threads that weren't given one and whose project config names none (`haiku` for cheap trial runs) |
| `TENZO_SNOOZE_MS` | 15 minutes | how long a swipe snoozes a card, in ms |
| `TENZO_PUSH_PREVIEW` | `short` | what a notification says: `short` (thread name and a short line) or `none` ("A thread needs you.") |
| `TENZO_PUSH_CONTACT` | the project's GitHub page | the `mailto:` or `https:` contact push services see (VAPID `sub`) |
| `TENZO_SMOKE_CHROMIUM` | Playwright's cache | the Chromium `pnpm smoke` drives (not read by the daemon) |

Each thread's environment also gets `TENZO_LIVE_BASE=/live/<thread>/`, the base path its dev server must serve under to be exposed.

### `$TENZO_HOME`

Created readable only by you.

| Path | What |
|---|---|
| `environment-id` | this machine's stable identity (`env_` + 20 chars), stamped on every record and event |
| `tenzo.db` | SQLite (WAL): the event log and its projections. Migrations run at start; a database newer than the code refuses to open |
| `daemon.pid` | the lock: one daemon per home. A second one refuses to start; a dead daemon's lock is taken over. If it names a pid something else now runs as, delete it |
| `worktrees/<project>/<thread-id>/` | threads' worktrees |
| `attachments/<thread-id>/` | copies of screenshots agents attached; removed when the thread is archived |
| `push-keys.json` | the VAPID key pair (0600); delete it and every device turns notifications on again |
| `automations.paused` | the automations off switch: exists = paused |
| `daemon.log` | the service's output |

### Keep it running (macOS)

```bash
pnpm build                                     # the service serves apps/web/build
TENZO_ALLOWED_HOSTS=my-mac.tailnet-1234.ts.net pnpm tenzo service install
pnpm tenzo service status                      # running (pid …), the plist and the log
pnpm tenzo service uninstall                   # stops it and removes the agent
```

`install` writes `~/Library/LaunchAgents/dev.tenzo.daemon.plist` (readable only by you) and loads it: `tenzo serve` from this checkout, with the Node that ran `install`, starting at login and again after a crash (at most every 10 s; a clean stop leaves it stopped). It bakes in the environment of the shell you ran it from: `PATH` (so threads find `claude`, `git` and your MCP servers' commands), `TENZO_*`, and your Claude configuration (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, proxies), with `TENZO_HOME` and `TENZO_WEB_DIR` made absolute. Terminal-session variables (`TERM*`, `TMUX*`, `SSH_*`, pnpm's, a parent Claude Code's) are left out. Output goes to `$TENZO_HOME/daemon.log`.

After changing any of those settings, moving the checkout or upgrading Node, run `install` again; it replaces the old agent. Stop a hand-started `tenzo serve` first: both want the same `TENZO_HOME`, and the service retries until it can take it. `install` warns when the checkout is a linked git worktree or when it runs inside Claude Code (the service would get that session's environment). Elsewhere than macOS, run `tenzo serve` under your own init system.

### Upgrading

1. `git pull` in the checkout the daemon runs from, then `pnpm install` if the lockfile changed.
2. `pnpm build` (the daemon's own TypeScript runs from source).
3. Restart the daemon: `tenzo service install` again, or stop and start `tenzo serve`. Running turns resume with a "Tenzo restarted" prompt; open questions stay on the Pass.
4. Migrations run at start. A database newer than the code refuses to open: update rather than roll back.

Prompt edits (`apps/daemon/prompts/*.md`) and project config edits need no restart: they apply from the next session or turn.

## Projects and threads

A project is a local git repo Tenzo knows about. Each thread gets its own worktree under `$TENZO_HOME/worktrees/<project>/<thread-id>` on a new branch `tenzo/<slug>`, so your main checkout is never touched. Archiving a thread removes its worktree and keeps its branch. Tenzo writes nothing into your repo.

```bash
pnpm tenzo project add ~/code/app              # any path inside the repo; detects the default branch
pnpm tenzo project list
pnpm tenzo project remove app                  # refuses while it has active threads; adding the repo
                                               # again restores it, history included
pnpm tenzo thread start app "create hello.txt containing hi"   # new thread; Claude starts on it (--model)
pnpm tenzo thread new app "Fix the login bug"  # just the worktree, no agent yet
pnpm tenzo thread send <thread-id> "now make it say hello"     # waits its turn if one is running
pnpm tenzo thread list [app] [--all]
pnpm tenzo thread log <thread-id> [--follow]
pnpm tenzo items                               # what the threads need from you, oldest first
pnpm tenzo answer <item-id> 2                  # an option's number or label, or your own words
pnpm tenzo thread archive <thread-id>          # refuses a dirty worktree; --force discards it (and
                                               # lets go of a thread whose repo was moved or deleted)
```

Project commands work on the database directly; thread commands go through the running daemon (same `TENZO_HOME` and `TENZO_PORT`). `start`, `send` and `answer` print the thread's events until it needs you (then they show the item and how to answer it) or goes idle; `--detach` returns at once, `--json` prints JSON lines. A `turn.completed` line shows the turn's cost and the session's running total (Claude's estimates), and how long the turn worked and waited on you. `thread list --all` marks a thread archived because its work landed as `archived · landed`.

The default branch is what `origin/HEAD` points at, else a local `main` or `master`, else the checked-out branch. A new thread first fetches it from `origin` (at most 10 s; only `origin/<default>` moves) and starts from whichever of your local default branch and origin's is newer, so work merged on GitHub is in the next thread even if you haven't pulled. If they have diverged it starts from yours and says so in the thread's timeline. A slug already used gets `-2`, `-3`, …

A thread without a title is named by its prompt's first words, then a few seconds later by a 2–4 word name from a one-shot `claude` on haiku. Its agent stays up between turns (background tasks keep reporting) until the thread is archived, the daemon stops, or a settings change needs a new session; the next prompt then resumes Claude's stored session.

To try it without touching your real state:

```bash
export TENZO_HOME=$(mktemp -d) TENZO_PORT=4796
git init -q -b main /tmp/scratch && git -C /tmp/scratch commit -q --allow-empty -m init
pnpm tenzo project add /tmp/scratch
pnpm tenzo serve &
pnpm tenzo thread start scratch --model haiku "create hello.txt containing hi"
```

### What a thread runs

Your own `claude` through the Claude Agent SDK, with your login and everything your terminal `claude` loads: user, project and local settings, `CLAUDE.md`, subagents, skills, hooks, MCP servers, plugins, and Claude Code's own system prompt. Tenzo appends its thread prompts (`apps/daemon/prompts/`), adds its own MCP server, `tenzo`, beside yours, and catches questions and permission prompts so they come to you. It sets no permission mode unless the project config says so: your own `defaultMode` applies. Variables a parent Claude Code session exports are dropped, so running Tenzo from inside Claude Code doesn't tie threads to that session; your Claude configuration (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, Bedrock/Vertex, proxies) passes through.

### Finished work

When a build is done the agent calls `report` (summary, how to test, checks) and the thread goes to review with a finished card. On it:

- **Screenshots** the agent `attach`ed: PNG, JPEG, GIF or WebP files from inside the thread's worktree, up to 10 MB each and 8 per report.
- **Open live**, after the agent `expose`d a port: its dev server at `/live/<thread>/` on the live listener. Paths are forwarded unchanged, so the server must serve under that base (Vite: `--base $TENZO_LIVE_BASE`). The port must answer, not be Tenzo, and belong to a process running in the thread's worktree (checked with `lsof` where there is one). The link works while the dev server runs, and answers 502 otherwise.

Answer with **Merge** (the filled button; the project's `landing` rule can make it **Open PR**), **Open PR**, **Done** (nothing to land), or words: **Needs changes**. From the CLI, only the word `merge` merges. While landing, the agent does the PR work itself with `gh` under the rules in `apps/daemon/prompts/landing.md`, wakes itself to check (`wake_me`), and comes to you only with a question or, after *Open PR*, a card when the PR is ready to merge. The thread archives once its work is in the default branch on origin. Landing threads have their own group in the Threads list, showing when they look again ("in 12m").

**Landing while you're away.** Under the default permission mode, every `gh` call while landing is a permission card. To let the read-only checks run on their own, allow them in your own `~/.claude/settings.json` (a committed `.claude/settings.json` in the repo works too; a `.claude/settings.local.json` in your main checkout doesn't reach threads' worktrees):

```json
{
  "permissions": {
    "allow": ["Bash(gh pr checks:*)", "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh run view:*)", "Bash(gh run list:*)"]
  }
}
```

Don't add `git` entries: prefix rules like `Bash(git fetch:*)` also match forms that run programs (`--upload-pack=`), overwrite branches or write files, and Tenzo's own `landed` check does the fetch it needs. Leave `git push`, `gh pr create` and `gh pr merge` off too: they still reach you as a quick tap.

## Project config

Optional: `.tenzo/config.json` (commit it) and `.tenzo/local.json` (yours; gitignore it) in the repo's main checkout. `local.json` overrides `config.json` key by key; anything missing is Claude's own default. Both are read before every turn, so edits apply from the next turn. Both live in the repo, so Tenzo treats them as the repo's: each must be a plain file inside the repo (not a link), at most 64 KB, and neither may grant what Claude Code wouldn't let the repo's own settings grant.

```json
{
  "agent": "claude",
  "models": {
    "discuss": { "model": "opus",   "thinking": "high" },
    "build":   { "model": "sonnet", "thinking": "medium" },
    "agents":  { "model": "haiku" }
  },
  "permissions": "acceptEdits",
  "landing": "pr"
}
```

| Key | |
|---|---|
| `agent` | `claude` (the only one until the Codex adapter exists) |
| `models.discuss` | until *Build it*. `model` as `--model`; `thinking` `off` (thinking disabled) or `low`/`medium`/`high` (Claude's effort level, what `/effort` sets) |
| `models.build` | from *Build it* on: building, review, landing. *Build it* switches the running session in place |
| `models.agents` | subagents' `model` (`CLAUDE_CODE_SUBAGENT_MODEL`), used only for a subagent whose own definition names none |
| `permissions` | the permission mode in every phase: `default`, `acceptEdits` or `dontAsk`. Absent (the usual), your own `defaultMode` applies. `auto` and `bypassPermissions` are refused here; set them in your own `~/.claude/settings.json`. `plan` isn't offered |
| `landing` | the finished card's filled button: `merge` (default) or `pr` |
| `automations` | below |

Which model wins: the thread's own (its "⋯" in the app, or `thread start --model`), then the project config, then `TENZO_DEFAULT_MODEL`, then Claude's own. Model names are letters, digits and `. _ : @ / [ ] -`, at most 100.

**When a change applies.** A running session takes a new model, effort level or thinking off live. Anything else (thinking back on, a new permission mode or subagent model) restarts the session at the next turn boundary, resuming the same conversation, but never while background work runs (a background subagent or shell, a Monitor): that change waits for a quiet boundary. Each switch shows in the thread's log as `session.configured`.

**An invalid file never stops a thread.** Its threads run on the defaults and one error card per project names the file and key. *Retry* reads it again; *Dismiss* puts the card away until something else is wrong; the card goes by itself once a turn starts with the file fixed.

## Automations

An automation is a saved thread recipe in the same config, under `automations`, by name (`a-z`, `0-9`, `-`, at most 40; at most 20 per project):

```json
{
  "automations": {
    "review-prs": {
      "prompt": "List open PRs with gh. For each one you haven't reviewed, run /code-review and post findings as a PR comment.",
      "trigger": { "schedule": "every 1h", "timeZone": "Europe/Rome" },
      "budget": { "wallClock": "30m", "costUsd": 2 },
      "model": "haiku",
      "thinking": "low"
    }
  }
}
```

| Key | |
|---|---|
| `prompt` | what the thread starts with (at most 8000 characters) |
| `trigger.schedule` | `every 15m` / `2h` / `1d` (at least 5 minutes); `hourly`; `daily 09:00`, `weekdays 09:00`; or a five-field cron line (`*/30 8-18 * * 1-5`; day fields combine as in Vixie cron). None: it runs only when you run it |
| `trigger.timeZone` | the IANA zone clock times are read in; default the machine's. A time skipped by a spring-forward runs as the clocks jump past it; one repeated by a fall-back runs once (so `hourly` leaves a two-hour gap that night; `every 1h` doesn't) |
| `budget.wallClock`, `budget.costUsd` | what one run may use before it pauses and asks: `1m` to `24h` (default `1h`), and Claude's spend estimate up to `20` USD (default `2`) |
| `model`, `thinking` | the run's model and thinking in every phase |
| `enabled` | `false` switches its schedule off (`local.json` can, for one you don't want on your machine) |

```bash
pnpm tenzo automation list [project]           # schedule, next run, last run
pnpm tenzo automation run <project> <name>     # run it now
pnpm tenzo automation pause | resume           # the off switch, for every schedule
pnpm tenzo automation archive <project> <name> # archive its finished runs with a clean worktree
```

- **A run is an ordinary thread** on branch `tenzo/<name>-<date>`: it discusses before it builds, runs with your own permissions, and its cards land on the Pass. The Threads list says "automation: <name>".
- **Bounded, because the repo writes it.** A definition can't set a permission mode. A schedule starts a run at most every 5 minutes, at most 3 runs go at once across projects, and a run that comes due while its previous one is still going (working, waiting on you, or paused) is skipped and recorded. The off switch lives in `$TENZO_HOME`, not the repo; running by hand still works while it is on.
- **Memory between runs.** Tenzo adds to the prompt which automation and trigger this is, what the previous run said last (its latest `report`, else its last answer, up to 1500 characters), and the notes file `.tenzo/automations/<name>.md`, which the agent may update and commit without proposing first (Tenzo says which commit has its newest version). It also asks the agent to leave markers in the systems it works in.
- **No pile-up.** When a run starts, its previous run is archived if it is done, clean, has no open card and no commits of its own; its branch stays.
- **Schedules survive restarts.** Runs missed while no daemon ran come once at start, then the schedule goes on from now. A config that can't be read changes no schedule; an automation removed from its config, or a removed project, loses its schedule.
- **Budgets pause and ask; they never kill.** Over its wall clock or cost, a run is paused (a turn still running at the deadline is interrupted) and a card asks: **Continue** grants one more budget from now, **Stop** archives the thread, words go to the agent with the same grant. A run's budget ends when the run is done.
