# Tenzo

Many coding agents working on your machine. One thing in your hands.

Tenzo runs long-lived agent threads (Claude Code first, Codex next) in their own worktrees on your computer and shows you **one item at a time** when a thread needs you: a question, a plan to approve, finished work to look at. You answer from your phone or any browser, and go back to whatever you were doing.

The name is the head cook of a Zen monastery. Dōgen's *Instructions for the Cook* is a treatise on giving whole attention to the one task in your hands while a whole kitchen simmers around you. **The Pass** is the counter where every plate goes past the chef before it leaves the kitchen; it's the main screen.

Self-hosted, open source, no cloud of ours. Your agents, your logins, your network.

See [docs/PRODUCT.md](docs/PRODUCT.md) for what it is, the decisions behind it, and the MVP scope. Mock-ups are in [docs/mockups](docs/mockups).

Status: pre-MVP. Nothing useful runs yet.

## Develop

Node 22.18+ and pnpm 10.

```bash
pnpm install
pnpm dev     # daemon on 127.0.0.1:4780 (TENZO_PORT to change), web on localhost:5173
pnpm check   # typecheck + tests in every package; CI runs the same
```

In `pnpm dev`, Vite proxies `/ws` and `/health` to the daemon, so the page always talks to its own origin. The daemon's dev script sets `TENZO_DEV_ORIGIN` to Vite's `http://localhost:5173` (and `127.0.0.1:5173`), the only other origin it accepts pages from.

## Run

```bash
pnpm build          # builds the web app into apps/web/build
pnpm tenzo serve    # daemon + web app on http://127.0.0.1:4780
```

`pnpm tenzo <command>` runs `apps/daemon/src/cli.ts` on Node's type stripping, with no build step. The file is executable and is the package's `tenzo` bin, so a symlink to it on your PATH gives you a bare `tenzo`.

The daemon serves the web app, `GET /health` (version and environment id) and the WebSocket at `/ws` from one origin, on loopback only. Threads' live apps (`expose`, below) are served by a second loopback listener on `TENZO_LIVE_PORT` (default the next port), an origin of their own. To reach Tenzo from a phone, put Tailscale Serve in front of both (two HTTPS routes) and pair the phone; the page switches to `wss:` by itself under HTTPS. One command does it, asking before it changes anything:

```bash
pnpm tenzo pair --tailscale --name "My iPhone"
```

**[docs/REMOTE.md](docs/REMOTE.md)** is the whole setup: what it does, the commands by hand, the settings, pairing Safari and the home-screen app, revoking, and troubleshooting. The security model is under [Remote access](#remote-access-pairing-devices) below.

On `/ws` the daemon sends a snapshot of active threads and open items, then every thread and item change as it happens; clients send the same commands as `POST /api/commands`, each answered by id. The frames are in `packages/contracts/src/frames.ts`; `packages/client-runtime` keeps the connection (reconnect, ping, wake-on-foreground) and a store the web app reads. A command whose connection drops before its answer fails as lost and isn't resent; to make trying again safe, `thread.create` takes a `clientKey` (New thread sends one per request), and the daemon answers a key it has seen, even before a restart, with the thread it made then (the same key with another project, title, prompt or model is refused).

| Variable | Default | |
|---|---|---|
| `TENZO_PORT` | `4780` | port to listen on |
| `TENZO_LIVE_PORT` | `TENZO_PORT` + 1 | port of the second listener, which serves only threads' live apps (`/live/`) |
| `TENZO_LIVE_ORIGIN` | none | the live listener's public origins, comma-separated (e.g. a second Tailscale Serve route, `https://my-mac.tailnet.ts.net:8444`); Open live links to the one with the host name you reached Tenzo by, else to the live port on that name |
| `TENZO_HOME` | `~/.tenzo` | Tenzo's state, private to you: `environment-id` (this machine's stable identity), `tenzo.db` (SQLite), `worktrees/`, `push-keys.json` (the VAPID keys notifications are signed with) |
| `TENZO_WEB_DIR` | `apps/web/build` | the built web app to serve |
| `TENZO_ALLOWED_HOSTS` | none | host names besides loopback that may reach the daemon, comma-separated (e.g. the Tailscale Serve name); see below |
| `TENZO_PUBLIC_URL` | none | where devices elsewhere reach Tenzo, port included, e.g. `https://my-mac.tailnet.ts.net:8443` (the Tailscale Serve route): the daemon gives it to `tenzo pair` for its links. Unset, `tenzo pair` needs `--url` |
| `TENZO_DEV_ORIGIN` | none (`pnpm dev` sets Vite's) | origins of dev servers whose pages may use the API and `/ws`, comma-separated |
| `TENZO_CLAUDE_PATH` | found | the `claude` threads run: by default the first on `PATH`, else `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` or `/usr/local/bin` |
| `TENZO_DEFAULT_MODEL` | Claude's own | the model for threads whose project's `.tenzo/config.json` names none and that weren't given one (e.g. `haiku` for cheap trial runs) |
| `TENZO_SNOOZE_MS` | 15 minutes | how long a swipe snoozes a card, in ms (e.g. `20000` to watch one come back) |
| `TENZO_PUSH_PREVIEW` | `short` | what a notification says: `short` (the thread's name and a short line) or `none` ("A thread needs you."); see [Notifications](#notifications-web-push) |
| `TENZO_PUSH_CONTACT` | Tenzo's project page | the `mailto:` or `https:` contact push services see (VAPID `sub`) |

### Keep it running (macOS)

`tenzo service` runs the daemon as a launchd user agent, so it starts at login and comes back after a crash or a reboot:

```bash
pnpm build                                     # the service serves apps/web/build
TENZO_ALLOWED_HOSTS=my-mac.tailnet-1234.ts.net pnpm tenzo service install
pnpm tenzo service status                      # running (pid …), the plist and the log
pnpm tenzo service uninstall                   # stops it and removes the agent
```

`install` writes `~/Library/LaunchAgents/dev.tenzo.daemon.plist` (readable only by you) and loads it. The agent runs `tenzo serve` from this checkout with the Node that ran `install`, in the environment of the shell you ran it from: your `PATH` (so threads find `claude`, `git` and your MCP servers' commands), `TENZO_*` settings such as `TENZO_ALLOWED_HOSTS` and `TENZO_PORT`, and your Claude configuration (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, proxies). Terminal-session variables (`TERM*`, `TMUX*`, `SSH_*`, pnpm's, a parent Claude Code's) are left out, and `TENZO_HOME` and `TENZO_WEB_DIR` are written as absolute paths. Output goes to `$TENZO_HOME/daemon.log` (`~/.tenzo/daemon.log` by default). launchd starts the daemon again when it exits with an error, at most every 10 s; a clean stop (SIGTERM) leaves it stopped. After changing any of those settings, moving the checkout or upgrading Node, run `install` again: it replaces the old agent. Stop a `tenzo serve` you started by hand first: it holds the same `TENZO_HOME`, and the service retries until it can take it. `install` warns when the checkout is a linked git worktree (removing it would leave the service failing at every start) or when it runs inside Claude Code (the service would get that session's environment). Elsewhere than macOS, run `tenzo serve` under your own init system.

## Projects and threads

A project is a local git repo Tenzo knows about. Each thread gets its own worktree under `$TENZO_HOME/worktrees/<project>/<thread-id>`, on a new branch `tenzo/<slug>` cut from the project's default branch, so your main checkout is never touched. Archiving a thread removes its worktree and keeps its branch. Tenzo writes nothing into your repo; a `.tenzo/` folder there is optional.

```bash
pnpm tenzo project add ~/code/app              # any path inside the repo; detects the default branch
pnpm tenzo project list
pnpm tenzo thread new app "Fix the login bug"  # worktree on branch tenzo/fix-the-login-bug
pnpm tenzo thread list [app] [--all]
pnpm tenzo thread archive <thread-id>          # refuses if the worktree has uncommitted changes; --force discards them
                                               # (--force also lets go of a thread whose repo was moved or deleted)
pnpm tenzo project remove app                  # refuses while the project has active threads; the repo and the
                                               # threads' history are kept, and adding the repo again restores it
```

Project commands work on the database directly; thread commands need the daemon running (`pnpm tenzo serve`, see below).

The default branch is what `origin/HEAD` points at, else a local `main` or `master`, else the checked-out branch. A slug the project already used, or one whose `tenzo/<slug>` branch already exists, gets `-2`, `-3`, … `thread new` makes the worktree without starting an agent; `thread start` (below) does both.

To try it without touching your real state, use a scratch `TENZO_HOME` and a scratch repo:

```bash
export TENZO_HOME=$(mktemp -d) TENZO_PORT=4796
git init -q -b main /tmp/scratch && git -C /tmp/scratch commit -q --allow-empty -m init
pnpm tenzo project add /tmp/scratch
pnpm tenzo serve &                             # thread commands go through the daemon
pnpm tenzo thread new scratch "Try it"
git -C /tmp/scratch worktree list              # main checkout plus the thread's worktree
pnpm tenzo thread archive <thread-id>          # worktree gone, branch tenzo/try-it kept
```

## Running Claude Code in a thread

Threads run your own `claude` (see `TENZO_CLAUDE_PATH`) through the Claude Agent SDK, with your own login and everything your terminal `claude` loads: user, project and local settings, `CLAUDE.md`, subagents, skills, hooks, MCP servers and plugins, and Claude Code's own system prompt. Tenzo never sets the permission mode, in any phase, unless the project's config says to (below): your own `defaultMode` applies, as in the terminal. It only appends its thread prompts to Claude Code's, adds its own MCP server (`tenzo`: `propose`, `report`, `attach`, `expose`, `wake_me`, `ready_to_merge`, `landed`, `start_thread`) next to yours, and catches questions and permission prompts so they can come to you. Threads get Tenzo's environment minus the variables a parent Claude Code session exports (`CLAUDECODE`, its session id, IDE port, bridge wiring), so running Tenzo from inside Claude Code doesn't tie its threads to that session; your configuration (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, Bedrock/Vertex, proxies) passes through.

A thread started from a prompt without a title is named in two steps: at once by the prompt's first few words, then, a few seconds later, by a 2–4 word name from a one-shot `claude` on haiku (no tools, no settings, not saved to your session history). If that fails, the first words stay. If the daemon stops before the name comes, the next daemon asks again when it starts.

The daemon runs the threads: thread commands go to it (start `pnpm tenzo serve` first, with the same `TENZO_HOME` and `TENZO_PORT`), so everything a client sees comes from one place.

```bash
pnpm tenzo thread start scratch --model haiku "create hello.txt containing hi"   # new thread; Claude starts on it
pnpm tenzo thread send <thread-id> "now make it say hello"   # another prompt; waits its turn if one is running
pnpm tenzo items                                             # what the threads need from you, oldest first
pnpm tenzo answer <item-id> 2                                # an option's number or label, or your own words;
                                                             # allow / deny / a reason to deny for a permission
pnpm tenzo thread log <thread-id> [--follow]                 # the thread's events
```

`start`, `send` and `answer` print the thread's events until it needs you (then they show the item and how to answer it) or goes idle; `--detach` returns at once, `--json` prints events as JSON lines. A thread's agent stays up between turns (background tasks keep reporting) until the thread is archived or the daemon stops, or a settings change needs a new session while nothing runs in the background (see Project config); the next prompt after that resumes Claude's stored session.

`pnpm parity` checks that a thread really has everything the terminal has: one real thread on haiku in a scratch project with a subagent, a skill, a hook and an MCP server, run through a scratch daemon, then a PASS/FAIL table. Re-run it after every adapter change; see [docs/PARITY.md](docs/PARITY.md).

`pnpm smoke` builds the web app and drives it in headless Chromium (iPhone emulation) against a scratch daemon, covering what unit tests can't see: it loads `/`, `/new` and `/threads` directly, walks New → Close → New → Close → Threads → ×, and fails on any page error, a second WebSocket or page load, or a lost draft; then it reloads on New and checks that Close goes back to the Pass behind it rather than stacking another. It needs no `claude` and leaves `~/.tenzo` and port 4780 alone. It uses `TENZO_SMOKE_CHROMIUM`, else Playwright's Chromium (`~/Library/Caches/ms-playwright` or `~/.cache/ms-playwright`; `pnpm --filter @tenzo/smoke exec playwright-core install --only-shell chromium` installs it). CI runs it as a job of its own next to `pnpm check`, with Chromium cached; locally, run it after changing routes or navigation.

### Project config: `.tenzo/config.json`

A project can say how its threads run in `.tenzo/config.json` (commit it) and `.tenzo/local.json` (yours, gitignore it), both optional, in the repo's main checkout. Tenzo only reads them, before each turn of each thread, so an edit applies from the next turn without a restart; `local.json` overrides `config.json` key by key. Anything missing is Claude's own default, from your Claude settings. Both files live in the repo, so Tenzo treats both as the repo's, never as yours: each must be a plain file inside the repo (not a link) of at most 64 KB, and neither may grant what Claude Code wouldn't let the repo's own settings grant.

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

| Key | | How Claude gets it |
|---|---|---|
| `models.discuss` | while the thread discusses, until *Build it* | `model` (`--model`); `thinking` `off` as thinking disabled, `low`/`medium`/`high` as Claude's effort level (`--effort`, what `/effort` sets) |
| `models.build` | from *Build it* on: building, review, landing | the same; *Build it* switches the running session in place (`setModel`, `applyFlagSettings({effortLevel})`, `setMaxThinkingTokens(0)` for off), since the build goes on in that same turn. What Claude can't take live (back to your own default model or thinking, thinking back on) applies from the next turn |
| `models.agents` | subagents (`model` only) | `CLAUDE_CODE_SUBAGENT_MODEL`, which Claude Code uses only for a subagent whose own definition (frontmatter `model`) and call name no model: your subagents' own choices win |
| `permissions` | the permission mode in every phase: `default`, `acceptEdits` or `dontAsk` | `permissionMode`. Absent (the usual), Tenzo sets none and your `defaultMode` applies. `auto` and `bypassPermissions` are refused from both files (Claude Code refuses them from a repo's own settings too, and Tenzo hands the mode over as a trusted flag): set them as `defaultMode` in your own `~/.claude/settings.json`, which threads use already. `plan` isn't offered (nothing could be built) |
| `landing` | the finished card's filled button: `merge` (default) or `pr` | the other one and *Done* stay in the row under it |

Which model wins, field by field: the thread's own (its "⋯" on the phone, `thread.setModel`, or `thread start --model`), then the project's config, then `TENZO_DEFAULT_MODEL`, then Claude's own. A thread's own model applies in every phase. Model names are letters, digits and `. _ : @ / [ ] -`, at most 100. With no config at all, threads run exactly as before: no model, thinking, effort, permission mode or subagent model is passed.

Before each turn the daemon works out what the thread should run with now (its own choice, its project's config, its phase). A running session takes what it can live: another named model, another effort level, thinking off. Going back to your own default asks Claude for it (`ANTHROPIC_MODEL`, else your settings' `model` and `effortLevel`). Anything else (thinking back on after off, another permission mode or subagent model) ends the session at that turn boundary, and the next one resumes Claude's conversation with the new options and is set to your own default model before its first turn. The turn waits for a switch; one Claude doesn't confirm within 15 s becomes such a restart, once (if the restarted session doesn't confirm either, the turn goes on what it has, with a note), and a session that won't end for it is let go of, its queued prompts on an error card whose Retry sends them. A session with background work running (a background subagent, a `run_in_background` shell, a Monitor, as Claude reports them), or in a turn Claude started by itself (a background task reporting), is never restarted, since that would cut the work off: the turn goes to it as it is, and the change waits for a turn boundary with nothing running in the background, or for the session's natural end (archive, a daemon restart), after which the next session starts with it. Each switch shows once in the thread's events as `session.configured` (`pnpm tenzo thread log <id>`).

An invalid file never stops a thread: its threads run on the defaults, and one error card per project says which file and key is wrong. *Retry* reads the file again, *Dismiss* puts the card away until something else is wrong, and the card goes by itself once a turn starts with the file fixed.

### Automations

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
| `trigger.schedule` | `every 15m` / `2h` / `1d` (a fixed interval, at least 5 minutes); `hourly`; `daily 09:00`, `weekdays 09:00`; or a five-field cron line (`*/30 8-18 * * 1-5`: numbers, `*`, ranges, steps, lists). The day fields combine as in Vixie cron and cronie: when either starts with `*` (`*`, `*/2`) a day must match both, otherwise either is enough. None: it runs only when you run it |
| `trigger.timeZone` | the IANA zone clock times are read in; default the machine's. A time a spring-forward day skips runs as the clocks jump past it (02:30 at 03:30); a time a fall-back day repeats runs once, the first time. So `hourly` leaves a two-hour gap on a fall-back night (Rome, 2026-10-25: 02:00 CEST, then 03:00 CET); `every 1h` doesn't |
| `budget.wallClock`, `budget.costUsd` | what one run may use before it pauses and asks: wall clock (`1m` to `24h`, default `1h`) and Claude's own spend estimate in USD (at most `20`, default `2`) |
| `model`, `thinking` | the run's model and thinking in every phase, as the thread's own choice (its "⋯" shows it) |
| `enabled` | `false` switches its schedule off (`local.json` can, for one you don't want to run on your machine) |

```bash
pnpm tenzo automation list [project]          # schedule, next run, last run (thread, cost, how it went)
pnpm tenzo automation run <project> <name>    # run it now
pnpm tenzo automation pause | resume          # the off switch: no schedule starts a run while paused
```

- **A run is an ordinary thread**: the normal create path, its own worktree and branch (`tenzo/<name>-<date>`), discuss first, your own permissions and settings. Its origin is `automation` (the Threads list says "automation: <name>"; `ThreadView.automation`), and its cards land on the Pass like any other. It can start threads with `start_thread`.
- **Bounded, because the repo writes it.** A schedule in the config just runs, so a file in the repo (a pull, a teammate's commit) decides what starts by itself. What it can make Tenzo do is bounded where the repo can't reach:
  - A definition can't set a permission mode, or anything else a thread you start yourself wouldn't get. It is checked like the rest of the file: strict keys, sizes, and the same plain-file rules.
  - Every run has a budget. It is 1h and $2 when the file sets none, and at most 24h and $20 when it does. Beyond that, you decide on the card.
  - An automation's schedule starts a run at most every 5 minutes, whatever its cron line says. Running it by hand isn't limited.
  - At most 3 automation runs go at once, across all projects. A schedule that comes due beyond that is skipped and recorded ("too many runs going").
  - The off switch, `tenzo automation pause`, lives in `$TENZO_HOME/automations.paused`, not in the repo, so `local.json` (which the repo can commit) is never the only brake. While it is on, due runs are skipped and recorded; running by hand still works. `snapshot.automationsPaused` shows it.
- **Memory between runs.** The run's prompt is the automation's prompt, then what Tenzo adds:
  - which automation and trigger this is;
  - what its previous run said last: its latest `report`, else its last answer, quoted, at most 1500 characters;
  - its notes file `.tenzo/automations/<name>.md`.

  Tenzo never writes the notes file. The prompt lets the agent update and commit that one file without proposing first; any other change still goes through the discuss flow. A run's worktree is cut from the default branch, so Tenzo looks (with a read-only `git log`, under a timeout) for the newest version among the default branch and the earlier runs' branches. When the worktree doesn't have it, the prompt names the commit to take it from (`git checkout <commit> -- <path>`). The prompt also asks the agent to leave markers in the systems it works in.
- **Skip if running.** A run that comes due while its previous run is still going is skipped and recorded, with the reason:
  - "still going": working, or landing;
  - "waiting on you": a question, a permission, a proposal, an error card, a ready PR;
  - "paused by its budget".

  A run is done once its agent ended a turn with nothing running or queued and nothing open but finished work, or once it is archived.
- **No pile-up.** When a run starts, its automation's previous run is archived if it is done, has no open card, has a clean worktree and has no commits beyond its base; its branch stays. A run with commits, or with a finished card waiting for you, stays.
- **Schedules survive restarts.** The next run of each automation is kept in SQLite (`automations`), and every run in `automation_runs`.
  - Runs missed while no daemon ran come once when it starts, not once per missed time; after that the schedule goes on from now.
  - A config that can't be read changes no schedule (its error card says why, as for any thread) and arms nothing. An automation removed from its config, or a removed project, loses its schedule.
- **Budgets pause and ask; they never kill.**
  - Wall clock counts from the run's start. Cost is Claude's running total for the session (`total_cost_usd`, an estimate), and Claude gets what is left of the cap as `maxBudgetUsd`, so it stops a turn there by itself. Any card of that turn goes with it.
  - A run over either one is paused. A turn still running at its wall-clock deadline is interrupted; one waiting on your answer is left to it and looked at again a minute later. Nothing more is sent to the agent.
  - A quick-lane card asks what to do:
    - **Continue** grants a fresh budget from that moment: the wall clock runs one budget from now, and the cap is one budget above what was spent (one API call can go past a cap). Claude's new cap needs a new session, which resumes the conversation at the next turn.
    - **Stop** archives the thread.
    - Words go to the agent, with the same grant.
  - A run's budget ends when the run is done: what you ask of the thread afterwards isn't held.

### Events and items

Every event the agent reports is appended to an append-only log in SQLite (`events`), in Tenzo's own vocabulary (`packages/contracts/src/runtime.ts`): `session.*`, `turn.*`, `item.*`, `request.opened/resolved`, `user-input.requested/resolved`, `runtime.error`. Nothing above the agent adapter (`apps/daemon/src/agent/`) knows it is talking to Claude.

The daemon folds the log into **items** (`apps/daemon/src/fold.ts`, a pure function; `items` table): each question (`AskUserQuestion`) and each permission request becomes one quick-lane item with the thread, the agent's last words before asking (trimmed), the ask, its options and the suggested one. Answering resolves it and hands the answer to the waiting agent. Prompts sent while a turn runs wait in a per-thread queue (`prompts`), which also survives restarts.

**When the agent that asked is gone.** If the daemon restarts (or Claude crashes) while a question or permission request is open, the item stays on the queue, marked as detached: nothing is waiting on it any more, but your answer still counts. Answering it records the answer, resumes the thread's Claude session, and sends a message saying what it asked and what you chose ("You asked: …  My answer: …", or for a permission "I allow it. Go ahead" / "I don't allow it: <reason>"). If the resumed agent then asks exactly the same question or requests exactly the same tool call again in that turn, as it usually does when it re-runs the tool, the daemon answers it with your answer instead of asking you twice. "Exactly" is a SHA-256 fingerprint of the tool and its full input, taken by the adapter before anything is shortened for display; anything that differs anywhere is asked again. Archiving a thread stops its agent and dismisses its items (a `thread.archived` event in the log).

### Finished work: report, attach, expose

When a build is done the agent calls `report(summary, how_to_test, checks)`: the thread goes to **review** and a review-lane card (after every quick-lane card) shows the handoff note, a badge per check, screenshots and an **Open live** link. `report` returns at once; nothing waits on it, and your answer goes back to the agent as its next message. A second report replaces the first card.

- `attach(path, caption?)` takes a PNG, JPEG, GIF or WebP (by its bytes; no SVG) of up to 10 MB from inside the thread's worktree, after symlinks are resolved and checked again on the open file (no hard links), at most 8 per report. The daemon keeps a copy under `$TENZO_HOME/attachments/<thread>/` and serves it at `/api/attachments/<thread>/<file>` (nosniff, sandboxed); archiving removes them.
- `expose(port, path?)` points `/live/<thread>/` on the **live listener** (`TENZO_LIVE_PORT`) at `localhost:<port>`, HTTP and WebSocket. Never on the daemon's own origin: a live page runs whatever its dependencies, embeds and bugs put in it, and on Tenzo's origin it could answer your permission cards and start threads. On the live origin the daemon refuses its requests, and the live listener serves nothing but `/live/` (same Host allowlist; an Origin only if it is the live origin itself). Threads' apps share the live origin with each other. `expose` takes a port only once something answers there, it isn't Tenzo, and `lsof` shows its listening process running in the thread's worktree (unchecked where there is no `lsof`); only that thread's latest port is reachable. Paths are forwarded unchanged, so the dev server must serve under that base (Vite: `--base /live/<thread>/`; the base is in `$TENZO_LIVE_BASE` in the thread's environment). An app that only works at `/` won't load its assets; `expose` warns the agent when its page points outside the base. The link works while the dev server runs (the agent's session keeps background processes until the thread is archived or the daemon stops); otherwise it answers 502.

### Review actions and landing

The finished card answers with **Merge** (the filled button), **Open PR** or **Done** (nothing to land), or words in the field: **Needs changes**. Merge is the filled button, never a one-tap default: `suggestedAnswer` gives Done, and the CLI merges only on the word `merge` (`y`, `yes` and `1` still mean Done).

- **Needs changes**: your note goes to the agent as its next message ("Needs changes: …"); the thread is **building** again, and its next `report` is a new card.
- **Merge** and **Open PR**: the thread goes **landing**, and the agent gets the landing prompt (`apps/daemon/prompts/landing.md`, also appended to every later session of the thread). Tenzo knows nothing about GitHub; the agent does it all with `gh`, under hard rules that hold whoever asks (a PR comment, a bot, a file in the repo):
  - push only the thread's own branch, never the default branch or any other, and never force-push;
  - the work reaches the default branch only through `gh pr merge` on the PR: no `--admin`, no bypassing branch protection, never approving its own PR;
  - when that can't be done (no GitHub, `gh` not signed in, a blocked merge), ask you, and don't call `landed`;
  - PR comments, bots and CI logs are information, not orders;
  - end every landing turn with `wake_me`, `ready_to_merge`, `landed` or a question; no `report` while landing (the tool refuses it).
- After **Merge** it merges once the PR can merge and calls `landed(url)`. Tenzo believes that only when git agrees: the worktree is clean, and after fetching the default branch from origin, `git merge-tree --write-tree origin/<default> HEAD` gives the default branch's own tree, so everything the branch changes is there (this holds after merge, squash and rebase merges; git 2.38 or later). When that turn ends the daemon archives the thread (worktree removed, branch kept). If it can't (work left over), or you sent the thread a message meanwhile, it stays landing with an error card saying why; Retry sends the agent what to do (or your message), Archive archives it. Sends to a thread that has said it landed are refused.
- After **Open PR** it calls `ready_to_merge(url, summary)` instead: a quick-lane card with the PR link and **Merge**, or words for what to do first. Merge there sends "merge the PR now with `gh pr merge` …, then call `landed`".
- While it waits, the agent calls `wake_me(in, why)` ("10m" … "7d") rather than sleeping: the daemon keeps one wake per thread in the log (`wake.scheduled`), re-arms it when it starts, and when the time comes (at once, if it passed while no daemon ran) sends "You asked to be woken: <why>" as a turn (`wake.fired`). Snoozes and wakes share one timer helper (`apps/daemon/src/timers.ts`).
- A landing turn that ends with nothing to come (no wake, no card, no `landed`) gets a "Landing stalled" error card: Retry reminds the agent how to land.
- Landing threads have their own group in the Threads list, with when they look again ("in 12m"); they stay there until they archive.

`start_thread(prompt, project?, title?)` lets an agent start another thread through the ordinary create (worktree, branch, discuss first). It records origin `agent` and the parent thread (`ThreadView.origin`, `parentId`). No fan-out: a thread an agent started can't start threads, a thread starts at most 10 in its life (counted in the database, not per session), and at most 10 agent-started threads are active at once.

### Who may call the daemon

The daemon's commands (`POST /api/commands`, and `/ws`) can start agents, so it refuses requests whose `Host` isn't 127.0.0.1, localhost or ::1 (against DNS rebinding), and browser requests (WebSocket upgrades included, which get no CORS preflight) from any page but its own: the same host and port it was reached at (for an allowed host, over https on any port, e.g. Tailscale Serve on `:8443`), or a `TENZO_DEV_ORIGIN`. Other localhost ports are refused. Put any other name you reach it by, such as its Tailscale Serve host, in `TENZO_ALLOWED_HOSTS`:

```bash
TENZO_ALLOWED_HOSTS=my-mac.tailnet-1234.ts.net pnpm tenzo serve
```

One daemon runs per `TENZO_HOME` (`daemon.pid`); a second one refuses to start. A lock left by a daemon that died is taken over; if it names a pid that something else now runs as, delete `daemon.pid`.

### Remote access: pairing devices

On the Mac itself Tenzo needs no login. Everything else is **remote** and needs a **paired device**: the API, `/ws`, attachments and threads' live apps. The web app's own files hold no data and stay open, so an unpaired phone gets a calm "Pair this device" page instead of a broken Pass.

**Pair your phone** (once per browser):

1. Tailscale Serve in front of the daemon with `--https` (never `--tcp`, see below), its name in `TENZO_ALLOWED_HOSTS`, and where the phone reaches it in the daemon's `TENZO_PUBLIC_URL`, port included, e.g. `https://my-mac.tailnet-1234.ts.net:8443`. (Or give it each time: `tenzo pair --url https://…:8443`.) `tenzo pair --tailscale` sets all of it up, live route included: see [docs/REMOTE.md](docs/REMOTE.md).
2. On the Mac: `tenzo pair --name "My iPhone"` (or `tenzo pair --tailscale --name "My iPhone"`). It prints a link and a QR code.
3. Scan it with the phone's camera within 10 minutes. The page pairs and lands on the Pass. The link works once.
4. Using Tenzo as a home-screen app on iOS? It keeps cookies of its own, apart from Safari's, and the camera opens links in Safari. Open the app (it shows "Pair this device"), copy the link on the Mac and paste it into the app's field (Universal Clipboard carries it over). Open live still works from the app: its links carry their own pass into Safari.

`tenzo devices` lists paired devices (name, when paired, last seen), `tenzo devices rename <id> <name…>` renames one, and `tenzo devices revoke <id>` unpairs it: its token stops working and its open connections (the Pass's socket, live apps' sockets) close at once. Threads → the phone icon shows the same list in the app, with Rename and Revoke. New devices are paired from the Mac only.

**Local or remote.** A request is local only when its socket comes from loopback, its `Host` names loopback (127.0.0.1, localhost, ::1), and it carries no proxy's forwarding header (`X-Forwarded-For`, `Forwarded`, `Tailscale-User-*`, …). Tailscale Serve connects from 127.0.0.1 but passes on the name the phone used and adds `X-Forwarded-For`, so its requests are remote on both counts: a phone that sends `Host: localhost` through Serve is still remote. Spoofing goes only one way: a local process that sends a tailnet `Host` or a forwarding header makes itself remote, and then needs a token like anyone else. (An SSH tunnel *to* the daemon's port, `ssh -L` from elsewhere, is local: that is the Mac's own login.)

> **Never forward raw TCP to Tenzo.** `tailscale serve --tcp` or `--tls-terminated-tcp`, `socat`, `ssh -R`, an ngrok TCP tunnel: they add no forwarding headers and let the client send `Host: localhost`, so **every client through them is local, with no pairing at all**. Use `tailscale serve --https` (an HTTP proxy) only. The same goes for any HTTP proxy that rewrites Host to loopback and drops the forwarding headers.

**Pairing.** `tenzo pair` asks the running daemon for a one-time code (26 random characters, 10 minutes, single use; only its hash is stored). The link is `https://<host>/pair#<code>`: the code rides in the fragment, which no request carries (nor logs, nor Referer). The page reads it, removes it from the address bar and posts it to `POST /api/pair` (JSON only, same origin only); the daemon trades it, once, for the device's own 256-bit token, stored as a SHA-256 hash in SQLite (`devices`, migration "paired devices"). Failed pairing attempts are limited to 10 a minute, for everyone together (behind Serve every request comes from 127.0.0.1); a good code is tried first and always pairs, and every `tenzo pair` lifts the limit, so a peer that keeps failing can't lock you out. Devices survive daemon restarts.

**The token** travels only in a cookie: `__Host-tenzo`, `HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain, 400 days. No script reads it and the response body never carries it; it needs HTTPS (Tailscale Serve), and the pair page says so when a browser drops it. The daemon takes it only from its own pages (`Sec-Fetch-Site` same-origin or none) on top of the Origin check.

**The live origin keeps its own credential.** Cookies ignore ports, so the browser sends `__Host-tenzo` to the live listener (`:8444`) too, and SameSite can't stop a live page from sending it to the daemon (same site). So: the daemon refuses the live origin's requests (Origin, and `Sec-Fetch-Site: same-site`); the live listener never accepts `__Host-tenzo`, strips it (and its own cookie) from every request before it reaches a dev server, and drops any `Set-Cookie` for them from the dev server, WebSocket handshakes included. The live listener takes only `__Host-tenzo-live`: a pass signed by the daemon (HMAC, key in SQLite) naming the device, checked against revocation on every request. A paired device gets an hour-long grant in its snapshot, renewed over its socket every 20 minutes; Open live goes through the live origin's door (`/_tenzo/live?grant=…&to=/live/<thread>/…`), which sets the live cookie for the granted device (a day, never past the device's own cookie; every Open live tap sets it again) and redirects to the page. A browser that already holds a good live cookie gets through even with an expired grant, and a page coming back with a stale grant reconnects for a fresh one. The live pass grants live apps and nothing else; a live page can't reach the API with it or anything else.

**Open live links are personal.** Whoever opens yours within the hour gets your device's access to threads' live apps (not to Tenzo) for a day at most, or until you revoke the device. Don't paste them into chats.

**No page frames Tenzo.** A live page is same-site with the Pass (cookies ignore ports), so a frame of the Pass there would load with your cookie, and an invisible one under a decoy button would answer cards with your tap; on the Mac, any website could do the same to the login-free Pass in Safari. Every response of the daemon's listener carries `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

What's public: the web app's files, `/health`, `GET /api/session` (whether this browser is local, paired or neither) and `POST /api/pair`.

### Notifications (Web Push)

A paired device can get a notification when a thread needs it, without Tenzo open. There is no cloud of ours: the daemon signs each message with its own VAPID key and posts it to the browser's push service (Apple's for iPhone, Google's for Chrome, Mozilla's for Firefox), encrypted end to end to that browser's key. That is the only connection it needs, and it is outbound, so a tailnet-only daemon can still reach your phone.

**What pushes.** Quick-lane cards only: a question, a permission, a proposal, an error or budget pause, a PR ready to merge. Never finished work (the review lane), and never a card already answered: the push waits out a 3 s burst and goes only if the card is still open. One notification per thread: its tag is the thread's id, so a newer card replaces it (and buzzes again), and cards arriving together make one push. A snoozed card pushes again when it comes back. No push goes to a muted device, nor to one that has Tenzo open and in view: the page tells the daemon over its socket (`visibility` frame), and a page that stops talking (a phone that froze it) counts as away after 45 s. Pushes are sent with `Urgency: high`, a one-hour TTL, and the thread as `Topic`, so an undelivered one is replaced rather than queued. A push service that fails (5xx, 429, no answer) is retried after 5 s, 30 s and 2 min (or its `Retry-After`) while the card is still open and the device still wants it; one that answers 404 or 410 gets the subscription forgotten.

**Turn them on** in Devices (Threads → the phone icon): on this device's card, *Turn on notifications* asks the browser's permission and hands the daemon the browser's subscription; then *Mute* / *Unmute* and *Test* (sends one now, muted or not), and *Turn off*. Other devices' cards show whether theirs are on, with Mute and Test. Each device has one subscription; revoking it deletes it. On the Mac itself Tenzo doesn't push: notifications are for paired devices.

**On iPhone** (iOS 16.4 or later), push works only in the home-screen app:

1. Pair Safari as above, open Tenzo, Share → **Add to Home Screen**.
2. Open Tenzo from the Home Screen. It has its own cookies, so pair it too (paste a fresh `tenzo pair` link into its field).
3. In the app: Threads → the phone icon → **Turn on notifications**, and allow. Tap **Test**.
4. Lock the phone and get a thread to ask something: the notification arrives within seconds. Tapping it opens the app on that card.

**Privacy.** A message says the thread's name and one short line (the question, "Allow Bash?" for a permission, never the command or its input, never context), cut to 60 and 120 characters, plus the card's id for the tap. It is encrypted to your browser, but Apple or Google still see when, how big, and to which subscription. `TENZO_PUSH_PREVIEW=none` makes every notification just "Tenzo · A thread needs you." The push services also see the VAPID contact, `TENZO_PUSH_CONTACT` (default `https://github.com/clawdude/tenzo`, so your tailnet name isn't sent; Apple rejects `localhost`). The keys are made once in `$TENZO_HOME/push-keys.json` (0600); deleting it means every device turns notifications on again. Push can't take a notification back, so when you open Tenzo it clears the notifications of threads that no longer need you.

The service worker (`/service-worker.js`) does notifications only: it caches nothing and handles no requests.
