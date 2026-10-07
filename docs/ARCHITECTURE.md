# Architecture

How Tenzo is built, and why, as of `main`. [PRODUCT.md](PRODUCT.md) says *what* Tenzo is; this file gives the mental model and the decisions to know before reading the code. Settings, commands and how-tos are in the [guide](GUIDE.md) and [REMOTE.md](REMOTE.md); shapes and schema in the code ([§6](#6-where-to-look-next)). A change to the architecture or to a decision updates this file in the same PR.

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

- **Daemon** (`apps/daemon/src`). One process per `$TENZO_HOME` (a pid lock). `server.ts` starts everything in order: config, lock, store and migrations, push keys, engine, the two listeners, then `engine.start()` to pick up where the last daemon left off. `app.ts` is the main listener (Hono + `ws`); `commands.ts` is the single entry for commands from both transports.
- **Storage** (`db.ts`, `store.ts`, `event-store.ts`, `fold.ts`). SQLite via `node:sqlite`. The `events` table is the source of truth; `threads`, `items` and the rest are projections written in the same transaction ([D2](#d2-an-event-log-folded-into-projections-replay-is-state)). Also a prompt queue per thread (`prompts`), automations and their runs, devices and push subscriptions.
- **Engine** (`engine.ts`). Owns threads at run time: pumps each thread's prompt queue into its session, delivers answers (`answers.ts`), keeps timers (wakes, snoozes, budgets; `timers.ts`), archives landed threads, raises error cards. Threads and worktrees: `threads.ts`, `projects.ts`, `git.ts`.
- **Agent layer** (`agent/`). `agent.ts` is the boundary: an `AgentAdapter` starts an `AgentSession` that streams normalized runtime events and takes turns and answers. `claude.ts` implements it with `@anthropic-ai/claude-agent-sdk`; `claude-events.ts` translates SDK messages. Nothing above this folder knows the agent is Claude (except the one-shot titler, `titles.ts`).
- **The `tenzo` MCP server** (`agent/tenzo-mcp.ts`). Injected into every session beside your own servers: `propose`, `report`, `attach`, `expose`, `wake_me`, `ready_to_merge`, `landed`, `start_thread`. They never ask you for permission.
- **Thread prompts** (`apps/daemon/prompts/`). `discuss.md`, `build.md`, `landing.md`: plain Markdown appended to Claude Code's own system prompt, read at every session start.
- **Project config** (`project-config.ts`). Optional `.tenzo/config.json` and `local.json` in the repo's main checkout, re-read before every turn.
- **Automations** (`automations.ts`). A scheduler over the automations in project configs; each run is an ordinary thread. Budgets are enforced in the engine.
- **Live listener** (`live.ts`). A second listener on its own origin that proxies `/live/<thread>/` (HTTP and WebSocket) to the dev server a thread exposed ([D10](#d10-live-apps-on-a-separate-origin)).
- **Access and auth** (`access.ts`, `auth.ts`, `devices.ts`). Host and Origin checks, the local-or-remote decision, pairing codes, device tokens, the live pass.
- **Push** (`push.ts`). Web Push with the daemon's own VAPID keys, outbound only.
- **Tailscale and service** (`tailscale*.ts`, `service.ts`). `tenzo pair --tailscale` adds the two Serve routes; `tenzo service` installs a launchd agent.
- **CLI** (`cli.ts`, `client.ts`). `tenzo serve` runs the daemon; thread commands go through it over `POST /api/commands`; project commands use the database directly.
- **Contracts** (`packages/contracts`). Every wire and storage shape as zod schemas. Both ends validate on arrival.
- **client-runtime** (`packages/client-runtime`). Framework-free: one WebSocket `Connection` (reconnect, ping, wake-on-foreground), a `TenzoClient` store fed by a pure reducer, thread feeds, pairing fetches. The web app imports only this.
- **Web app** (`apps/web`). Svelte 5, SvelteKit static SPA, Tailwind v4. Screens in `src/routes/` (the Pass, New, Threads, a thread's timeline, Automations, Devices, Pair); pure, tested logic in `src/lib/*.ts`; a notifications-only service worker that caches nothing.
- **Tools.** `tools/smoke` drives the built web app in headless Chromium; `tools/parity` proves a real thread still has subagents, skills, hooks and MCP servers ([its README](../tools/parity/README.md)).

## 3. Core flows

### A thread's life

`discussing → building → review → landing → archived` (archived is the thread's status, not a phase).

1. **Create.** The daemon fetches the default branch from origin (non-interactive, at most 10 s; a failure is let go), cuts a worktree on a new branch `tenzo/<slug>` from the newer of your local default branch and origin's ([D7](#d7-one-worktree-and-branch-per-thread)), and inserts the thread. Without a title, the prompt's first words stand in until a one-shot `claude` on haiku (no tools, no settings, not saved to your history) names it; a daemon that stopped first asks again at start.
2. **Discuss.** The session runs with `discuss.md`. The agent reads, asks if it must, and calls `propose(summary)`, which waits: a proposal card goes on the Pass.
3. **Build.** *Build it* returns from `propose` with the approval and `build.md`, switches to the build model inside the same turn, and the phase becomes building. Follow-up messages run directly.
4. **Report.** `report(summary, how_to_test, checks)` returns at once, puts a finished card on the Pass (review lane) and the thread enters review; a second report replaces the card. `attach` copies an image into `$TENZO_HOME/attachments/<thread>/`, served at `/api/attachments/<thread>/<file>` (nosniff, sandboxed): checked by its bytes (no SVG), inside the worktree after symlinks are resolved and checked again on the open file, no hard links. `expose` points the live listener at a port ([D10](#d10-live-apps-on-a-separate-origin)).
5. **Land.** *Merge* or *Open PR* reaches the agent as a message carrying `landing.md`, which is also appended to every later session of the thread; *Needs changes* sends your note back to building; *Done* leaves it. While landing the agent calls `wake_me(in, why)` ("10m" … "7d"; one wake per thread, kept as `wake.scheduled`, re-armed at start, fired as a "You asked to be woken" turn), `ready_to_merge(url, summary)` after *Open PR* (a quick-lane card with *Merge*), and `landed(url)` once merged. `report` is refused while landing. A landing turn that ends with nothing to come (no wake, card or `landed`) gets a "Landing stalled" card whose Retry reminds the agent how to land.
6. **Archive.** After `landed` holds ([D9](#d9-landed-is-believed-only-when-git-agrees)) the engine archives at turn end: session stopped, items dismissed, worktree removed, branch kept. If it can't (work left over), or you sent a message meanwhile, the thread stays landing with an error card (Retry, Archive); sends to a thread that landed are refused. Archiving by hand refuses a dirty worktree unless forced.

### A question becomes a card, and the answer gets back

Claude asks through `canUseTool`: `AskUserQuestion` becomes a `user-input.requested` event, any permission prompt a `request.opened`, `propose` a `proposal.requested`. Each event is appended, folded into an open item (the agent's last words before asking, trimmed; the ask; its options and the suggested one), and pushed to clients as an `item` frame; the web app orders the pile (quick lane, then age). An answer is an `item.answer` command. If the asking session is still up, it is handed to the session (**live**) and the call waits for the `*.resolved` event. Otherwise (the session ended, or the item is finished work, a ready PR or an error) the resolution event and a prompt for the agent are written in one transaction and the queue is pumped (**message**). Prompts sent while a turn runs wait in the thread's queue, which survives restarts.

### Restart and recovery

On `SIGINT`/`SIGTERM` the daemon stops every session (a turn cut short queues a "Tenzo restarted while you were working" prompt), closes all sockets and listeners, and releases the lock. On start, `engine.start()` records `session.exited` for threads still marked live, resumes queued prompts by Claude's stored session id, archives threads that landed, names stand-in titles, re-arms wakes, snoozes and budget timers (past times fire now), and starts the scheduler. Open asks stay on the Pass as **detached** items ([D8](#d8-items-survive-restarts-detached-answers-and-fingerprints)). Clients reconnect and get a fresh snapshot.

### Automations

An automation lives in the project config: a name, a prompt, an optional schedule, a model, a budget. The scheduler keeps each one's next run in SQLite (`automations`, every run in `automation_runs`) and fires what is due; missed runs come once. A run is an ordinary thread with origin `automation`. Its first prompt carries memory: the previous run's last words, and where the notes file `.tenzo/automations/<name>.md` is newest (a read-only `git log` over the default branch and earlier runs' branches; the prompt names the commit to take it from). A run is done once its agent ended a turn with nothing running or queued and nothing open but finished work, or once archived; a due run whose previous run isn't done is skipped and recorded with the reason.

Budgets ([D14](#d14-automations-are-bounded-by-defaults-without-an-approval-gate-user-decision)): wall clock counts from the run's start; cost is Claude's running `total_cost_usd`, and Claude gets what is left as `maxBudgetUsd`, so it stops a turn there itself. Over either, the run is paused on a quick-lane card; a turn running at the deadline is interrupted, one waiting on your answer is left to it and looked at a minute later. *Continue* grants one budget from now (the cap becomes one budget above what was spent, which needs a new session at the next turn); *Stop* archives.

### Remote access and pairing

Tailscale Serve terminates HTTPS on the tailnet and forwards to the two loopback listeners; `tenzo pair --tailscale` adds the missing routes after you confirm, never touching others, and gets the daemon running with matching settings. `tenzo pair` (on the Mac only) asks the daemon for a one-time code (26 random characters, 10 minutes, single use; only its hash stored) and prints `https://<host>/pair#<code>`: the code rides in the fragment, which no request, log or Referer carries. The page removes it from the address bar and posts it to `POST /api/pair` (JSON, same origin), which trades it once for a 256-bit device token, stored as a SHA-256 hash and set as the `__Host-tenzo` cookie. Failed attempts are limited to 10 a minute for everyone together (behind Serve every request is from 127.0.0.1); a good code is tried first and always pairs, and every `tenzo pair` lifts the limit, so a failing peer can't lock you out. Revoking a device stops the token and closes its sockets (the Pass's and live apps') at once.

### Push

Only quick-lane items push ([D13](#d13-push-only-to-known-push-services)). Per thread, the first card opens a 3-second window, then one push goes for the newest card if it is still open; its tag is the thread, so a newer card replaces the notification, and a snoozed card pushes again when it comes back. Never to a muted device, or one whose page is in view: the page reports its visibility over its socket (`visibility` frame), and a page that stops talking counts as away after 45 s. Sends carry `Urgency: high`, a one-hour TTL and the thread as `Topic`, so an undelivered one is replaced, not queued. A failed send (5xx, 429, no answer) retries after 5 s, 30 s and 2 min (or `Retry-After`) while the card is still open, still its thread's latest push, and the device still wants it; 404 or 410 forgets the subscription; a push that can't be built isn't retried. Payloads hold the thread title and one short line, never context or a command's input. Each device has one subscription, deleted when it is revoked; the service worker re-subscribes on `pushsubscriptionchange`, and the app re-sends its subscription each time it opens. A test notification goes at most every 10 s per device and reports only whether the push service took it.

## 4. Architectural decisions

Short ADRs. Decisions marked **user decision** were made explicitly by the user and are not to be revisited without them; the rest follow from [PRODUCT.md](PRODUCT.md).

### D1. The daemon owns all state; clients are thin
- **Decision.** Everything (threads, items, timers, config reads, push) lives in the daemon. On `/ws` a client gets a snapshot, then every change; it sends the same commands as `POST /api/commands`, each answered by id.
- **Why.** One source of truth for a phone, a laptop browser and the CLI; native or desktop shells can be added on `client-runtime` later.
- **Trade-off.** No offline use: commands are never queued on the client, and a reconnect gets a fresh snapshot, not a replay. A command whose connection drops is lost, not resent; to make retrying safe, `thread.create` takes a `clientKey`, and the daemon answers a key it has seen (even before a restart) with the thread it made then, refusing the same key with other parameters.

### D2. An event log folded into projections; replay is state
- **Decision.** Every runtime event is appended to `events` (triggers forbid update and delete), in Tenzo's own vocabulary (`session.*`, `turn.*`, `item.*`, `request.*`, `user-input.*`, `runtime.error`). `fold.ts` is a pure function from a thread's state and an event to the new state and item changes; `appendEvent` writes the event and the projections in one transaction. Item ids derive from request ids.
- **Why.** Folding a thread's whole log gives the same state and items, so the projection can't drift and a restarted daemon shows exactly what it showed before.
- **Trade-off.** Every state change must be an event. Migrations are append-only; a database newer than the code refuses to open. Tenzo keeps only its own events (tool output cut to 2,000 chars); transcripts stay Claude's.

### D3. Run the user's real `claude`; never reduce Claude Code
- **Decision.** Threads run your own `claude` through the Agent SDK with `settingSources: user, project, local`, Claude Code's preset system prompt with Tenzo's prompt appended (never replaced), and Tenzo's MCP server merged beside yours. The environment is yours minus a parent Claude Code session's variables. Tenzo sets no permission mode by default. Sessions resume by Claude's session id.
- **Why.** Feature parity is non-negotiable. `pnpm parity` proves it after adapter changes.
- **Trade-off.** Tenzo depends on SDK behaviour. Some setting changes (permission mode, subagent model, spend cap, thinking back on) can't be applied live and need a session restart at a turn boundary, never while background work runs. A live switch Claude doesn't confirm within 15 s becomes such a restart, once; a session that won't end for it is let go, its queued prompts on an error card whose Retry sends them.

### D4. One adapter boundary
- **Decision.** The engine sees only runtime events and `AgentSession` calls; Claude specifics live under `agent/`.
- **Why.** A second agent (Codex, deferred) is a new adapter, not a rewrite; tests run on fake agents and never spawn `claude`.

### D5. Prompts over features; Tenzo knows nothing about GitHub
- **Decision.** Phase behaviour is text: `discuss.md`, `build.md`, `landing.md`, editable without a restart. Tenzo has no tracker, GitHub or CI integration; the agent uses `gh` and whatever else it has.
- **Why.** Keep Tenzo light and configurable; deleting it loses nothing.
- **Trade-off.** Some guarantees are only as strong as the prompt (D15). Where it matters, Tenzo checks the outcome mechanically (D9).

### D6. Pause through MCP tools, not plan mode
- **Decision.** Discussing is held by the prompt and `propose`, not by a permission mode; finished work, merge-readiness and landing are reported through tools too. A system prompt is fixed for a session's life, so the answer that changes phase carries the next prompt (*Build it* carries `build.md`; *Merge*/*Open PR* carry `landing.md`).
- **Why.** Plan mode is a permission mode and would override yours; with a tool, *Build it* continues in the same turn and the agent stays the agent you configured.

### D7. One worktree and branch per thread
- **Decision.** Each thread gets `$TENZO_HOME/worktrees/<project>/<thread>` on branch `tenzo/<slug>` (`--no-track`) from the default branch. Archive removes the worktree and keeps the branch. Tenzo writes nothing into your repo and clones nothing.
- **Base.** Creating a thread first fetches `origin/<default>` (the same fetch as D9's, capped at 10 s; failure or no origin: carry on), then branches from whichever of `<default>` and `origin/<default>` contains the other; when they have diverged, from your local one, with a `thread.noted` event saying so. Only the remote-tracking ref moves: Tenzo never updates, resets or checks out your branches. A thread's diff (and an automation run's "anything to keep?" check) is measured from its nearest fork point off either ref, so work merged upstream never counts as the thread's.
- **Why.** Parallel agents on one checkout trample each other and your own work. After a thread lands, origin is ahead of a default branch you haven't pulled; a thread cut from the stale one would miss the merged work.
- **Trade-off.** Disk per thread; a dev server must serve under `/live/<thread>/` to be exposed. Creating a thread can wait up to 10 s on an unresponsive origin.

### D8. Items survive restarts: detached answers and fingerprints
- **Decision.** When a session ends with a question, permission or proposal open, the card stays on the Pass, marked detached. Your answer resumes the session as a message ("You asked: … My answer: …", "I allow it. Go ahead", "I don't allow it: <reason>"), with a standing reply attached. If the resumed agent asks exactly the same thing in that turn (same SHA-256 fingerprint over the tool name and its full input, taken before anything is shortened for display), the engine answers from the standing reply; anything that differs is asked again. A cut-short turn is resumed once; a second interruption becomes an error card.
- **Why.** Nothing you answered is lost to a restart, and Tenzo never auto-approves a request you didn't see. The one-resume rule stops crash loops.

### D9. `landed` is believed only when git agrees
- **Decision.** `landed` succeeds only with a clean worktree and when, after fetching, `git merge-tree --write-tree origin/<default> HEAD` gives `origin/<default>`'s own tree: everything the branch changes is already there (after merge, squash or rebase merges; git 2.38+). Otherwise the thread stays landing.
- **Why.** Unmerged work must never drop off the list because an agent said so.

### D10. Live apps on a separate origin
- **Decision.** `expose` serves a thread's dev server only on the live listener, an origin of its own that serves nothing but `/live/` (same Host allowlist; an Origin only if it is the live origin itself). It takes a port only once something answers there, it isn't Tenzo, and `lsof` shows its process running in the thread's worktree; only the thread's latest port is reachable, and the agent is warned when its page points outside the base. The main listener refuses the live origin's requests (Origin, and `Sec-Fetch-Site: same-site`). The live listener never accepts the device cookie: it strips `__Host-tenzo` and its own cookie from every request before it reaches a dev server, and drops any `Set-Cookie` for them, WebSocket handshakes included. It takes only `__Host-tenzo-live`, an HMAC-signed pass naming the device (key in SQLite), checked against revocation on every request. A paired device gets an hour-long grant in its snapshot, renewed over its socket every 20 minutes; Open live goes through the live origin's door (`/_tenzo/live?grant=…&to=/live/<thread>/…`), which sets the live cookie for a day (never past the device's own) and redirects.
- **Why.** A live page runs whatever its dependencies put in it, and cookies ignore ports; on Tenzo's origin, or holding Tenzo's cookie, it could answer your cards and start threads.
- **Trade-off.** A second Tailscale route. Live apps share one origin with each other. Without `lsof` the port is unchecked. An Open live link grants whoever opens it within the hour your device's access to live apps for up to a day.

### D11. Repo-controlled config is untrusted
- **Decision.** `.tenzo/config.json` and `local.json` are read only from regular files inside the repo (no symlinks, ≤ 64 KB, re-checked on the open file). `permissions` may only be `default`, `acceptEdits` or `dontAsk`; `auto` and `bypassPermissions` belong in your own `~/.claude/settings.json`. Automation definitions can't set a permission mode. The automations off switch lives in `$TENZO_HOME`, not the repo. An invalid config never stops a thread: it runs on defaults and one config card says what's wrong.
- **Why.** Anyone who can commit to the repo must not be able to raise an agent's permissions or remove the brake.

### D12. Local vs remote by peer, Host and forwarding headers; pairing, no cloud of ours
- **Decision.** A request is local only when the peer is loopback, `Host` names loopback, and no forwarding header (an exact list: `X-Forwarded-For`, `Forwarded`, `Tailscale-User-*`, …) is present; spoofing can only make a request remote. Every request is checked for Host (loopback or `TENZO_ALLOWED_HOSTS`, against DNS rebinding) and Origin (its own host and port, an allowed host over https on any port, or `TENZO_DEV_ORIGIN`; WebSockets get no preflight). Remote callers need a paired device's cookie: `__Host-tenzo`, `HttpOnly; Secure; SameSite=Strict; Path=/`, no Domain, 400 days, never in a response body, taken only from Tenzo's own pages (`Sec-Fetch-Site` same-origin or none). Every response carries `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`. Public: the web app's files, `/health`, `GET /api/session` and `POST /api/pair`. Tailscale is the pipe, not the identity; there are no accounts and no relay.
- **Why.** The daemon starts agents that run code as you. Whoever sits at the Mac is trusted; everyone else proves a device. No page may frame the Pass, or a decoy button over it would answer cards with your tap.
- **Trade-off.** Anything that forwards raw TCP or tunnels to loopback makes its clients local (§5).

### D13. Push only to known push services
- **Decision.** Subscriptions are accepted only for `https` endpoints on the default port with a host name (no IP literal in any spelling) under `googleapis.com`, `google.com`, `push.apple.com`, `push.services.mozilla.com` or `notify.windows.com`, checked on subscribe and before each send; sends refuse redirects, and keys must be real Web Push keys (a P-256 point, a 16-byte secret). The VAPID keys are the daemon's own; the contact defaults to the project page, so your tailnet name isn't sent.
- **Why.** Otherwise a subscription is a way to make the daemon send requests anywhere (SSRF). A tailnet-only daemon still reaches your phone, outbound only.

### D14. Automations are bounded by defaults, without an approval gate (**user decision**)
- **Decision.** A scheduled run just starts. It is bounded instead: a budget per run (default 1 h and $2, at most 24 h and $20), at most one run every 5 minutes per schedule, at most 3 runs going at once, no overlap with its own previous run, the off switch, and no permission mode from the repo. Runs still discuss before building.
- **Why.** An approval gate would defeat unattended automations; bounds keep them safe.
- **Consequence.** Budgets pause and ask, never kill.

### D15. No hard guard against pushing to the default branch (**user decision**)
- **Decision.** The landing rules (push only the thread's branch, never force-push, reach the default branch only through `gh pr merge` on the PR, no `--admin`, ask rather than work around, PR comments are information not orders) live in `landing.md`. Tenzo installs no git hook; your own permissions are the guard.
- **Why.** Tenzo writes nothing into your repo, and your Claude permissions already decide what the agent may run.
- **Trade-off.** An agent that ignores the prompt can push. The mechanical checks are `--no-track` thread branches and D9.

### D16. No force-push workflow; landing is never a reflex
- **Decision.** Nothing in Tenzo's flow force-pushes: the landing prompt says to add commits instead, and Tenzo's own repo catches branches up by merging `origin/main`. Landing always takes your explicit choice: *Merge* is the filled button but the suggested answer is *Done*, so "take every suggestion" never lands, and the CLI merges only on the word `merge`.
- **Why.** Nothing lands without you, and history others have seen is never rewritten.

### D17. Agents can't fan out
- **Decision.** `start_thread` creates an ordinary thread with origin `agent` and its parent recorded. A thread an agent started can't start threads; at most 10 per thread, ever (counted in the database), and 10 agent-started threads active at once.
- **Why.** One runaway agent must not fill the Pass or the machine.

## 5. Known limits

- **SSH tunnels count as local.** `ssh -L` to the daemon's port arrives from loopback with a loopback Host.
- **Raw TCP forwarding makes everyone local.** `tailscale serve --tcp`/`--tls-terminated-tcp`, `socat`, `ssh -R`, ngrok TCP (or an HTTP proxy that rewrites Host to loopback and drops forwarding headers) bypass pairing. Use only `tailscale serve --https`.
- **Cost figures are Claude's estimates**; a session that ended before saving its total can undercount a run.
- **One daemon, one machine.** The client talks to one daemon; the Codex adapter is deferred.
- Also: no hard guard against pushing to the default branch (D15); live apps share one origin and need `lsof` for the worktree check (D10).

## 6. Where to look next

- [Guide](GUIDE.md): running, the CLI, every environment variable, `$TENZO_HOME`, project config, automations, upgrading. [REMOTE.md](REMOTE.md): Tailscale, pairing, notifications, troubleshooting.
- [PRODUCT.md](PRODUCT.md): what Tenzo is and the product decisions. [ROADMAP.md](ROADMAP.md): the plan. [CONTRIBUTING.md](../CONTRIBUTING.md): how work is done, checks, the T3 Code map.
- Sources of truth in code:
  - commands, results, WebSocket frames, runtime events, items, config: `packages/contracts/src/`
  - the schema and its migrations: `apps/daemon/src/db.ts`
  - env vars: `apps/daemon/src/config.ts`; routes: `apps/daemon/src/app.ts`, `live.ts`
  - the event fold and item kinds: `apps/daemon/src/fold.ts`; answer delivery: `engine.ts`, `answers.ts`
  - the MCP tools and their guards: `apps/daemon/src/agent/tenzo-mcp.ts`, `agent/claude.ts`
  - the smoke checks: `tools/smoke/src/smoke.ts`; CI: `.github/workflows/check.yml`
