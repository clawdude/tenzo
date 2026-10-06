# Architecture

How Tenzo is built, and why, as of `main`. [PRODUCT.md](PRODUCT.md) says *what* Tenzo is; this file gives the mental model and the architectural decisions you need before reading the code. Details (every env var, command, frame, migration) live in the [README](../README.md) and in the code that is their source of truth; [§6](#6-where-to-look-next) says where.

## Keeping this document current

This document describes `main` at the level of architecture. A PR that changes the architecture (a part, a boundary, a core flow, the storage model, the security model) or one of the decisions below updates this file in the same PR; a new decision gets an entry. Details change elsewhere: env vars, CLI and how-tos in the README, shapes in `packages/contracts`, the schema in `apps/daemon/src/db.ts`. When the code and this file disagree, the code wins and this file gets fixed.

## 1. The big picture

A **daemon** on your Mac runs each **thread** (one Claude Code session on one project) in its own git worktree, records everything the agent does as an append-only event log in SQLite, and folds that log into **items**: what a thread needs from you (a question, a permission, a proposal, finished work, a PR ready to merge, an error). Thin clients (the web app on a phone or browser, and the `tenzo` CLI) show one item at a time on **the Pass** and send your answers back.

```
 phone / browser elsewhere                       the Mac
 ─────────────────────────                       ──────────────────────────────────────────────────
                     Tailscale Serve (HTTPS, tailnet only)
  Pass (web app) ──▶ :8443 ──▶ 127.0.0.1:4780  main listener: web app, /api/*, /ws
                                    │            access guard → local or paired → commands
  Open live ─────▶ :8444 ──▶ 127.0.0.1:4781  live listener: /live/<thread>/ → localhost:<exposed port>
                                    │
  tenzo CLI (on the Mac) ── POST /api/commands
                                    ▼
                                  Engine ─────────── Automations scheduler
                                    │  prompt queue, items, timers, budgets
                     ┌──────────────┴─────────────┐
                     ▼                            ▼
              AgentAdapter                   SQLite  $TENZO_HOME/tenzo.db
              (Claude adapter)               event log (append-only) + projections
                │ Agent SDK + in-process MCP server "tenzo"
                ▼
              your `claude`, cwd = $TENZO_HOME/worktrees/<project>/<thread>
              (branch tenzo/<slug>, cut from the project's default branch)

  Push ── outbound HTTPS ──▶ Apple / Google / Mozilla / Microsoft push service ──▶ phone
```

Ports are the defaults (`TENZO_PORT`, live = port + 1; Serve on 8443/8444). On the Mac itself no login is needed; everything else is remote and needs a paired device.

## 2. The parts

A pnpm workspace; Node ≥ 22.18 runs the daemon's TypeScript directly, with no build step.

- **Daemon** (`apps/daemon/src`). One process per `$TENZO_HOME` (a pid lock). `server.ts` starts everything in order: config, lock, store and migrations, push keys, engine, the two listeners, then `engine.start()` to pick up where the last daemon left off. `app.ts` is the main listener (Hono + `ws`): the built web app, `/health`, `/api/*` and `/ws`. `commands.ts` is the single entry for commands from both transports.
- **Storage** (`db.ts`, `store.ts`, `event-store.ts`, `fold.ts`). SQLite via `node:sqlite` in `$TENZO_HOME/tenzo.db`. The `events` table is the source of truth; `threads`, `items` and the rest are projections written in the same transaction ([D2](#d2-an-event-log-folded-into-projections-replay-is-state)). Also a prompt queue per thread, automation runs, devices and push subscriptions.
- **Engine** (`engine.ts`). Owns threads at run time: pumps each thread's prompt queue into its session, delivers answers, keeps timers (wakes, snoozes, budgets), archives landed threads, raises error cards. Threads and worktrees: `threads.ts`, `projects.ts`, `git.ts`.
- **Agent layer** (`apps/daemon/src/agent/`). `agent.ts` is the boundary: an `AgentAdapter` starts an `AgentSession` that streams normalized runtime events and takes turns and answers. `claude.ts` implements it with `@anthropic-ai/claude-agent-sdk`; `claude-events.ts` translates SDK messages into events. Nothing above this folder knows the agent is Claude (the one-shot titler, `titles.ts`, is the exception).
- **The `tenzo` MCP server** (`agent/tenzo-mcp.ts`). Injected into every session beside your own servers. Its tools are how the agent talks to Tenzo: `propose`, `report`, `attach`, `expose`, `wake_me`, `ready_to_merge`, `landed`, `start_thread`. They never ask you for permission.
- **Thread prompts** (`apps/daemon/prompts/`). `discuss.md`, `build.md`, `landing.md`, plain Markdown appended to Claude Code's own system prompt, read at every session start.
- **Project config** (`project-config.ts`). Optional `.tenzo/config.json` and `.tenzo/local.json` in the repo's main checkout: agent, models per phase, permission override, landing rule, automations. Re-read before every turn, so edits apply without a restart.
- **Automations** (`automations.ts`). A scheduler over the automations in project configs; each run is an ordinary thread. Budgets are enforced in the engine.
- **Live listener** (`live.ts`). A second listener on its own origin that proxies `/live/<thread>/` (HTTP and WebSocket) to the dev server a thread exposed ([D10](#d10-live-apps-on-a-separate-origin)).
- **Access and auth** (`access.ts`, `auth.ts`, `devices.ts`). Host and Origin checks on every request, local-or-remote decision, pairing codes, device tokens, the live pass.
- **Push** (`push.ts`). Web Push with the daemon's own VAPID keys, outbound only.
- **Tailscale setup and service** (`tailscale*.ts`, `service.ts`). `tenzo pair --tailscale` adds the two Serve routes; `tenzo service` installs a launchd agent.
- **CLI** (`cli.ts`, `client.ts`). `tenzo serve` runs the daemon; other commands talk to it over `POST /api/commands` (project commands use the database directly).
- **Contracts** (`packages/contracts`). Every wire and storage shape as zod schemas: runtime events, items, commands and results, WebSocket frames, project config, schedules. Both ends validate on arrival.
- **client-runtime** (`packages/client-runtime`). Framework-free: one WebSocket `Connection` (reconnect, ping, wake-on-foreground), a `TenzoClient` store fed by a pure reducer, thread feeds, pairing fetches. The web app imports only this.
- **Web app** (`apps/web`). Svelte 5, SvelteKit static SPA, Tailwind v4. Screens in `src/routes/` (the Pass, New, Threads, a thread's timeline, Automations, Devices, Pair); pure, tested logic in `src/lib/*.ts`; a notifications-only service worker.
- **Tools** (`tools/smoke`, `tools/parity`). `pnpm smoke` drives the built web app in headless Chromium against a scratch daemon; `pnpm parity` runs one real Claude thread to prove subagents, skills, hooks and MCP servers still work ([PARITY.md](PARITY.md)).

## 3. Core flows

### A thread's life

`discussing → building → review → landing → archived` (archived is the thread's status, not a phase).

1. **Create.** The daemon fetches the default branch from origin (bounded and non-interactive; a failure is let go), cuts a worktree on a new branch `tenzo/<slug>` from the newer of your local default branch and origin's ([D7](#d7-one-worktree-and-branch-per-thread)), and inserts the thread (idempotent by `clientKey`). If the two have diverged, a `thread.noted` event says it started from yours. Without a title, the prompt's first words stand in until a one-shot `claude` on haiku names it.
2. **Discuss.** The session runs with `discuss.md`. The agent reads, asks if it must, and calls `propose(summary)`, which waits: a proposal card goes on the Pass.
3. **Build.** *Build it* returns from `propose` with the approval and `build.md`, switches to the build model inside the same turn, and the phase becomes building. Follow-up messages run directly.
4. **Report.** `report(...)` puts a finished card on the Pass (handoff note, check badges, screenshots from `attach`, a live link from `expose`) and the thread enters review; the agent ends its turn.
5. **Land.** *Merge* or *Open PR* reaches the agent as a message carrying `landing.md`; *Needs changes* sends your note back to building; *Done* leaves it. While landing the agent can `wake_me` later, `ready_to_merge(url)` (a card with *Merge*), and `landed(url)` once merged. A landing turn that ends with nothing to come gets a "stalled" card.
6. **Archive.** After `landed` (verified against git, [D9](#d9-landed-is-believed-only-when-git-agrees)) the engine archives at turn end: session stopped, worktree removed, branch kept. Archiving by hand refuses a dirty worktree unless forced.

### A question becomes a card, and the answer gets back

Claude asks through `canUseTool`: `AskUserQuestion` becomes a `user-input.requested` event, any permission prompt a `request.opened`, `propose` a `proposal.requested`. Each event is appended, folded into an open item, and pushed to clients as an `item` frame; the web app orders the pile (quick lane, then age). An answer is an `item.answer` command. If the asking session is still up, it is handed to the session (**live**) and the call waits for the `*.resolved` event. Otherwise (the session ended, or the item is finished work, a ready PR or an error) the resolution event and a prompt for the agent are written in one transaction and the queue is pumped (**message**).

### Restart and recovery

On `SIGINT`/`SIGTERM` the daemon stops every session (a turn cut short queues a "Tenzo restarted while you were working" prompt), closes all sockets and listeners, and releases the lock. On start, `engine.start()` records `session.exited` for threads still marked live (killed, not stopped), resumes queued prompts by Claude's stored session id, archives threads that landed, names stand-in titles, re-arms wakes, snoozes and budget timers from their tables (past times fire now), and starts the scheduler (missed schedules run once). Open asks stay on the Pass as **detached** items ([D8](#d8-items-survive-restarts-detached-answers-and-fingerprints)). Clients reconnect and get a fresh snapshot.

### Automations

An automation lives in the project config: a name, a prompt, an optional schedule (`every 1h`, `daily 09:00`, cron, …), a model, a budget. The scheduler fires what is due; a run is an ordinary thread with origin `automation` that discusses before it builds like any other. Its first prompt carries memory: the previous run's last words and where the automation's notes file (`.tenzo/automations/<name>.md`) is newest. Over budget, the run pauses on a quick-lane card (*Continue* or *Stop*). A finished, clean previous run is archived when the next one starts.

### Remote access and pairing

Tailscale Serve terminates HTTPS on the tailnet and forwards to the two loopback listeners; `tenzo pair --tailscale` adds the missing routes after you confirm, never touching others, and gets the daemon running with matching `TENZO_ALLOWED_HOSTS`, `TENZO_LIVE_ORIGIN` and `TENZO_PUBLIC_URL` (editing the launchd service, or printing the `tenzo serve` command). `tenzo pair` (on the Mac only) makes a single-use code valid for 10 minutes and prints a link with the code in the URL fragment. The phone posts it to `/api/pair` and gets a fresh device token as the `__Host-tenzo` cookie; only hashes are stored. Revoking a device stops the token and closes its sockets at once. Steps are in [REMOTE.md](REMOTE.md).

### Push

Only quick-lane items (the agent is stuck waiting) push. Per thread, the first such card opens a 3-second window, then one push goes for the newest card; never to a muted device or one whose page is in view. Payloads hold the thread title and one short line, never context or a command's input (`TENZO_PUSH_PREVIEW=none` makes it generic). Failed sends retry with backoff while the card is still open; a gone subscription is forgotten.

## 4. Architectural decisions

Short ADRs. Decisions marked **user decision** were made explicitly by the user and are not for an agent to revisit; the rest follow from [PRODUCT.md](PRODUCT.md).

### D1. The daemon owns all state; clients are thin
- **Decision.** Everything (threads, items, timers, config reads, push) lives in the daemon. Clients render a snapshot plus changes and send commands; HTTP and WebSocket share one command entry.
- **Why.** One source of truth for a phone, a laptop browser and the CLI; native or desktop shells can be added on `client-runtime` later.
- **Trade-off.** No offline use: commands are never queued on the client, and a reconnect gets a fresh snapshot, not a replay.

### D2. An event log folded into projections; replay is state
- **Decision.** Every runtime event is appended to `events` (triggers forbid update and delete). `fold.ts` is a pure function from a thread's state and an event to the new state and item changes; `appendEvent` writes the event and the projections in one transaction. Item ids derive from request ids.
- **Why.** Folding a thread's whole log gives the same state and items, so the projection can't drift and a restarted daemon shows exactly what it showed before.
- **Trade-off.** Every state change must be an event. Migrations are append-only; a database newer than the code refuses to open. Tenzo keeps only its own events (tool output cut to 2,000 chars); transcripts stay Claude's.

### D3. Run the user's real `claude`; never reduce Claude Code
- **Decision.** Threads run your own `claude` binary through the Agent SDK with `settingSources: user, project, local`, Claude Code's preset system prompt with Tenzo's prompt appended (never replaced), and Tenzo's MCP server merged beside yours. The environment is yours minus a parent Claude Code session's variables (so Tenzo inside Claude Code doesn't tie threads to it). Tenzo sets no permission mode by default: your own `defaultMode` applies in every phase. Sessions resume by Claude's session id.
- **Why.** Feature parity is non-negotiable: subagents, skills, hooks, MCP servers and plugins must work as in the terminal. `pnpm parity` proves it after adapter changes.
- **Trade-off.** Tenzo depends on SDK behaviour. Some setting changes (permission mode, subagent model, spend cap, thinking back on) can't be applied live and need a session restart at a turn boundary, never while background work runs.

### D4. One adapter boundary
- **Decision.** The engine sees only runtime events and `AgentSession` calls; Claude specifics live under `agent/`.
- **Why.** A second agent (Codex, deferred) is a new adapter, not a rewrite; tests run on fake agents and never spawn `claude`.

### D5. Prompts over features; Tenzo knows nothing about GitHub
- **Decision.** Phase behaviour is text: `discuss.md`, `build.md`, `landing.md`, editable without a restart. Tenzo has no tracker, GitHub or CI integration; the agent uses `gh` and whatever else it has.
- **Why.** Keep Tenzo light and configurable; deleting it loses nothing.
- **Trade-off.** Some guarantees are only as strong as the prompt (see D15). Where it matters, Tenzo checks the outcome mechanically (D9).

### D6. Pause through MCP tools, not plan mode
- **Decision.** Discussing is held by the prompt and `propose`, not by a permission mode; finished work, merge-readiness and landing are reported through tools too. A system prompt is fixed for a session's life, so the answer that changes phase carries the next prompt (*Build it* carries `build.md`; *Merge*/*Open PR* carry `landing.md`).
- **Why.** Plan mode is a permission mode and would override yours; with a tool, *Build it* continues in the same turn and the agent stays the agent you configured.

### D7. One worktree and branch per thread
- **Decision.** Each thread gets `$TENZO_HOME/worktrees/<project>/<thread>` on branch `tenzo/<slug>` (`--no-track`) from the default branch. Archive removes the worktree and keeps the branch. Tenzo writes nothing into your repo and clones nothing.
- **Base.** Creating a thread first fetches `origin/<default>` (the same non-interactive fetch as D9's, capped at 10 s; failure or no origin: carry on with what is there), then branches from whichever of `<default>` and `origin/<default>` contains the other. When they have diverged it branches from your local one and records a `thread.noted` event saying so. Only the remote-tracking ref moves: Tenzo never updates, resets or checks out your branches. A thread's diff (and an automation run's "anything to keep?" check) is measured from its nearest fork point off either `<default>` or `origin/<default>`, so work merged upstream never counts as the thread's, whichever it was cut from and however the two have moved since.
- **Why.** Parallel agents on one checkout trample each other and your own work. After a thread lands, origin is ahead of a local default branch you haven't pulled; a thread cut from the stale one would miss the merged work.
- **Trade-off.** Disk per thread; a dev server must serve under `/live/<thread>/` to be exposed. Creating a thread can wait up to 10 s on an unresponsive origin.

### D8. Items survive restarts: detached answers and fingerprints
- **Decision.** When a session ends with a question, permission or proposal open, the card stays on the Pass, marked detached. Your answer is delivered as a message, with a standing reply attached. If the resumed agent asks exactly the same thing (same SHA-256 fingerprint over the tool name and its full input), the engine answers from the standing reply; anything that differs is asked again. A cut-short turn is resumed once; a second interruption becomes an error card.
- **Why.** Nothing you answered is lost to a restart, and Tenzo never auto-approves a request you didn't see. The one-resume rule stops crash loops.

### D9. `landed` is believed only when git agrees
- **Decision.** `landed` succeeds only with a clean worktree and when, after fetching, the branch's changes are already in `origin/<default>` (holds after merge, squash and rebase). Otherwise the thread stays landing.
- **Why.** Unmerged work must never drop off the list because an agent said so.

### D10. Live apps on a separate origin
- **Decision.** `expose` serves a thread's dev server only on the live listener, its own origin, with its own credential (an HMAC-signed `__Host-tenzo-live` pass reached through a door URL). The main listener refuses the live origin; the live listener strips Tenzo's cookies both ways and never accepts the device cookie. `expose` checks that the port isn't Tenzo and that its process runs in the thread's worktree.
- **Why.** A live page runs whatever its dependencies put in it; on Tenzo's origin it could answer your cards and start threads.
- **Trade-off.** A second Tailscale route. Live apps share one origin with each other.

### D11. Repo-controlled config is untrusted
- **Decision.** `.tenzo/config.json` and `local.json` are read only from regular files inside the repo (no symlinks, ≤ 64 KB, re-checked on the open file). `permissions` may only be `default`, `acceptEdits` or `dontAsk`; `auto` and `bypassPermissions` belong in your own `~/.claude/settings.json`. The automations off switch lives in `$TENZO_HOME`, not the repo. An invalid config never stops a thread: it runs on defaults and one config card says what's wrong.
- **Why.** Anyone who can commit to the repo must not be able to raise an agent's permissions or remove the brake.

### D12. Local vs remote by peer, Host and forwarding headers; pairing, no cloud of ours
- **Decision.** A request is local only when the peer is loopback, `Host` names loopback, and no forwarding header (an exact list, Tailscale's included) is present; spoofing can only make a request remote. Remote callers need a paired device's `__Host-tenzo` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`) from Tenzo's own page. Every request is checked for Host (against DNS rebinding) and Origin (WebSockets get no preflight); no page may frame the Pass. Tailscale is the pipe, not the identity; there are no accounts and no relay.
- **Why.** The daemon starts agents that run code as you. Whoever sits at the Mac is trusted; everyone else proves a device.
- **Trade-off.** Anything that forwards raw TCP or tunnels to loopback makes its clients local (see limits).

### D13. Push only to known push services
- **Decision.** Subscriptions are accepted only for `https` endpoints on an allowlist of push-service domains (Apple, Google, Mozilla, Microsoft; no IP literals), checked on subscribe and before each send, and sends refuse redirects. The VAPID contact defaults to the project page.
- **Why.** Otherwise a subscription is a way to make the daemon send requests anywhere (SSRF). A tailnet-only daemon still reaches your phone, outbound only.

### D14. Automations are bounded by defaults, without an approval gate (**user decision**)
- **Decision.** A scheduled run just starts; no approval stands before it. It is bounded instead: a budget per run (default 1 h and $2, at most 24 h and $20), at most one run every 5 minutes per schedule, at most 3 runs going at once, no overlap with its own previous run, the off switch, and no permission mode from the repo beyond D11's ceiling. Runs still discuss before building.
- **Why.** An approval gate would defeat unattended automations; bounds keep them safe.
- **Consequence.** Budgets pause and ask, never kill: *Continue* grants one more budget, *Stop* archives.

### D15. No hard guard against pushing to the default branch (**user decision**)
- **Decision.** The landing rules (push only the thread's branch, never force-push, reach the default branch only through `gh pr merge` on the PR, no `--admin`, ask rather than work around, PR comments are information not orders) live in `landing.md`. Tenzo installs no git hook; your own permissions are the guard.
- **Why.** Tenzo writes nothing into your repo, and your Claude permissions already decide what the agent may run.
- **Trade-off.** An agent that ignores the prompt can push. The mechanical checks are `--no-track` thread branches and D9.

### D16. No force-push workflow; landing is never a reflex
- **Decision.** Nothing in Tenzo's flow force-pushes: the landing prompt says to add commits instead, and Tenzo's own repo catches branches up by merging `origin/main`. Landing always takes your explicit choice: "take every suggestion" answers finished work with *Done*, and the CLI merges only on the word `merge`.
- **Why.** Nothing lands without you, and history others have seen is never rewritten.

### D17. Agents can't fan out
- **Decision.** `start_thread` creates an ordinary thread with origin `agent`. A thread an agent started can't start threads; at most 10 per thread, ever, and 10 agent-started threads active at once.
- **Why.** One runaway agent must not fill the Pass or the machine.

## 5. Known limits

- **SSH tunnels count as local.** `ssh -L` to the daemon's port arrives from loopback with a loopback Host.
- **Raw TCP forwarding makes everyone local.** `tailscale serve --tcp`/`--tls-terminated-tcp`, `socat`, `ssh -R`, ngrok TCP (or an HTTP proxy that rewrites Host to loopback and drops forwarding headers) bypass pairing. Use only `tailscale serve --https`.
- **No hard guard against pushing to the default branch** (D15).
- **Live apps share one origin** with each other (not with Tenzo).
- **`expose`'s worktree check needs `lsof`**; without it the port is unchecked.
- **Cost figures are Claude's estimates**; a session that ended before saving its total can undercount a run.
- **One daemon, one machine.** The client talks to one daemon; the Codex adapter is deferred.

## 6. Where to look next

- [README](../README.md): running, developing, the `tenzo` CLI, every environment variable, `$TENZO_HOME`'s layout, project config keys, automations, redeploying. `tenzo --help` prints the CLI usage.
- [REMOTE.md](REMOTE.md): Tailscale Serve, pairing, revoking, troubleshooting.
- [PARITY.md](PARITY.md): the feature-parity check.
- [PRODUCT.md](PRODUCT.md): what Tenzo is and the product decisions. [ROADMAP.md](ROADMAP.md): the plan. [REFERENCE.md](REFERENCE.md): the T3 Code map.
- Sources of truth in code:
  - commands, results, WebSocket frames, runtime events, items, config: `packages/contracts/src/`
  - the schema and its migrations: `apps/daemon/src/db.ts`
  - env vars: `apps/daemon/src/config.ts`; routes: `apps/daemon/src/app.ts`, `live.ts`
  - the event fold and item kinds: `apps/daemon/src/fold.ts`; answer delivery: `engine.ts`, `answers.ts`
  - the MCP tools and their guards: `apps/daemon/src/agent/tenzo-mcp.ts`, `agent/claude.ts`
  - the smoke checks: `tools/smoke/src/smoke.ts`; CI: `.github/workflows/check.yml`
