# Architecture

How Tenzo is built and how it works inside, as of `main`. [PRODUCT.md](PRODUCT.md) says *what* Tenzo is and *why*; this file says *how*, with the file that does each thing. How-tos live in the [README](../README.md), [REMOTE.md](REMOTE.md) (Tailscale and pairing) and [PARITY.md](PARITY.md) (the feature-parity check); this file links to them rather than repeating them.

## Keeping this document current

This document describes `main`. Every PR that changes behaviour, structure, the SQLite schema, the protocol (frames, commands, events), project config, environment variables, the CLI, the security model or the working process updates this file in the same PR. Reviewers check it; a PR that changes any of those without updating this file is not done. When the code and this file disagree, the code wins and this file gets fixed.

## Contents

1. [Overview](#1-overview)
2. [Repo layout](#2-repo-layout)
3. [The daemon](#3-the-daemon)
4. [Storage](#4-storage)
5. [The agent layer](#5-the-agent-layer)
6. [Thread lifecycle](#6-thread-lifecycle)
7. [Items and the Pass](#7-items-and-the-pass)
8. [Protocol](#8-protocol)
9. [client-runtime](#9-client-runtime)
10. [The web app](#10-the-web-app)
11. [Project config](#11-project-config)
12. [Automations](#12-automations)
13. [Remote access and security](#13-remote-access-and-security)
14. [Product decisions recorded in code](#14-product-decisions-recorded-in-code)
15. [Testing and verification](#15-testing-and-verification)
16. [Operating](#16-operating)

---

## 1. Overview

Tenzo is an attention queue for coding agents. A **daemon** on your Mac runs each **thread** (one Claude Code session on one project) in its own git worktree, records everything the agent does as an append-only event log in SQLite, and folds that log into **items**: the things a thread needs from you (a question, a permission, a proposal, finished work, a PR ready to merge, an error). Thin clients (the web app on a phone or browser, and the `tenzo` CLI) show one item at a time on **the Pass** and send your answers back. Claude Code runs as the real `claude` binary with your own configuration; Tenzo only appends its thread prompts and injects one MCP server of its own.

```
 phone / browser elsewhere                      the Mac
 ─────────────────────────                      ──────────────────────────────────────────────────────
                         Tailscale Serve (HTTPS, tailnet only)
  Pass (web app) ──https──▶ :8443 ──http──▶ 127.0.0.1:4780  main listener (app.ts)
   │  /ws, /api/*                                │   web app files, /health, /api/*, /ws
   │                                             │   access guard → auth → commands
   │                                             ▼
  Open live ──https──▶ :8444 ──http──▶ 127.0.0.1:4781  live listener (live.ts)
                                                 │   /live/<thread>/… → localhost:<exposed port>
                                                 │
  tenzo CLI (on the Mac) ──POST /api/commands────┘
                                                 ▼
                                       Engine (engine.ts) ── Automations scheduler (automations.ts)
                                         │   prompt queue, timers, items, budgets
                                         │                      │
                                         ▼                      ▼
                          AgentAdapter (agent/agent.ts)   SQLite $TENZO_HOME/tenzo.db
                          Claude adapter (agent/claude.ts)  events (append-only) + projections
                            │  @anthropic-ai/claude-agent-sdk
                            │  + in-process MCP server "tenzo" (agent/tenzo-mcp.ts)
                            ▼
                          your `claude` binary, cwd = $TENZO_HOME/worktrees/<project>/<thread>
                          (branch tenzo/<slug>, cut from the project's default branch)

  Push (push.ts) ──outbound HTTPS──▶ Apple / Google / Mozilla / Microsoft push service ──▶ phone
```

On the Mac itself (loopback, no proxy headers) no login is needed. Everything else is **remote** and needs a paired device ([§13](#13-remote-access-and-security)).

## 2. Repo layout

A pnpm workspace (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tools/*`). Node ≥ 22.18; TypeScript runs on Node's type stripping, with no build step for the daemon.

| Path | Package | What lives there |
|---|---|---|
| `apps/daemon` | `@tenzo/daemon` | The daemon and the `tenzo` CLI (`src/cli.ts`, the package's `bin`). Hono + `ws` HTTP/WebSocket server, `node:sqlite` store, engine, Claude adapter, automations, devices, push, Tailscale setup, launchd service. Thread prompts in `prompts/`. |
| `apps/web` | `@tenzo/web` | The web app: Svelte 5, SvelteKit with `adapter-static` (SPA, `fallback: index.html`, `ssr = false`), Tailwind v4. Pure logic in `src/lib/*.ts` (tested), components in `src/lib/*.svelte`, screens in `src/routes/`, service worker in `src/service-worker/`. |
| `packages/contracts` | `@tenzo/contracts` | Every wire and storage shape as zod schemas: runtime events, queue items, thread views, commands and results, WebSocket frames, project config, automations, devices, schedules, diff. Shared by daemon, client-runtime and web. |
| `packages/client-runtime` | `@tenzo/client-runtime` | Framework-free client: `Connection` (one WebSocket, reconnect, liveness), `TenzoClient` (store + commands), thread feeds, session/pairing fetches. The web app imports only this package. |
| `tools/smoke` | `@tenzo/smoke` | `pnpm smoke`: the built web app in headless Chromium (Playwright) against a scratch daemon. |
| `tools/parity` | `@tenzo/parity` | `pnpm parity`: one real Claude thread proving subagents, skills, hooks and MCP servers work ([PARITY.md](PARITY.md)). Fixture in `tools/parity/fixture`. |
| `docs/` | | `PRODUCT.md` (decisions), `ROADMAP.md` (plan), `REFERENCE.md` (T3 Code map), `REMOTE.md`, `PARITY.md`, `mockups/`, this file. |
| `.github/workflows/check.yml` | | CI: `check` and `smoke` jobs ([§15](#15-testing-and-verification)). |

Root scripts (`package.json`):

| Script | Does |
|---|---|
| `pnpm dev` | `pnpm -r --parallel dev`: the daemon with `node --watch src/cli.ts serve` and `TENZO_DEV_ORIGIN` set to Vite's origins, plus `vite dev` on :5173, which proxies `/health`, `/ws`, `/api/attachments`, `/api/session`, `/api/pair` to the daemon (`apps/web/vite.config.ts`). |
| `pnpm build` | `pnpm -r build`: builds the web app into `apps/web/build`, which the daemon serves. |
| `pnpm check` | `pnpm -r typecheck && pnpm -r test`: `tsc` per package, `svelte-check --fail-on-warnings` plus the service worker's own `tsc` for the web app, then vitest everywhere that has tests. What CI runs. |
| `pnpm smoke` | Builds the web app, then `node tools/smoke/src/smoke.ts`. |
| `pnpm parity` | `node tools/parity/src/parity.ts` (needs a signed-in `claude`; spends a few cents). |
| `pnpm tenzo <cmd>` | `node apps/daemon/src/cli.ts <cmd>`: the CLI ([§16](#16-operating)). |

## 3. The daemon

### Startup

`tenzo serve` (`cli.ts` → `serve()`) reads the config and calls `startDaemon` (`server.ts`):

1. **Config** from the environment (`config.ts` `readConfig`): ports, home, web dir, allowed hosts, origins, defaults; nonsense fails loudly.
2. **Home lock** (`home.ts` `lockHome`): creates `$TENZO_HOME` (mode 0700) and takes `daemon.pid`, written aside and hard-linked into place so it is atomic. A lock whose pid isn't running is moved aside and taken over; a running holder makes startup fail. One daemon per home.
3. **Store** (`store.ts` `openStore`): loads or creates `environment-id` (`environment.ts`, created atomically by hard link, never silently replaced), opens `tenzo.db` with `busy_timeout=5000`, WAL, and runs pending migrations ([§4](#4-storage)); back-fills `environment_id` on old rows.
4. **VAPID keys** (`push.ts` `loadVapidKeys`): `push-keys.json` (0600), made once.
5. **Engine** (`engine.ts`) with the Claude adapter (`createClaudeAdapter`), the titler (`titles.ts`), `TENZO_DEFAULT_MODEL` and `TENZO_SNOOZE_MS`.
6. **Devices** (`devices.ts`) and **Push** (`push.ts`).
7. **Main listener**: `createApp` (`app.ts`) on `127.0.0.1:TENZO_PORT`, with a `ws` server in `noServer` mode (`maxPayload` 1 MB).
8. **Live listener**: `createLiveApp` (`live.ts`) on `127.0.0.1:TENZO_LIVE_PORT` (default port + 1), plus a raw `upgrade` handler (`liveUpgrade`) for WebSockets. The engine learns its port and public origins (`engine.setLive`).
9. `push.start(engine)` (subscribes to engine changes), then **`engine.start()`**, which picks up where the last daemon left off:
   - threads still marked `live` get a `session.exited`. If the turn was cut short (running, not waiting on you), `RESTART_PROMPT` ("Tenzo restarted while you were working…", `answers.ts`) is queued first, once; a turn that was itself such a resume gets an error card instead (`exitKind: "error"`), so a crash loop can't keep resuming;
   - threads whose agent called `landed` in their last turn are archived (unless a landing card is open);
   - threads with queued prompts are pumped (their Claude session resumes by its stored session id);
   - threads still under a stand-in title are named again;
   - `wake_me` wakes, snoozes and automation wall-clock budgets are re-armed from the log (`timers.ts`; a time already passed fires now);
   - the automations scheduler starts (missed schedules run once).
10. **Heartbeat** (`socket.ts` `heartbeat`): every 30 s each socket is pinged; one that didn't answer since the last round is terminated.

`SIGINT`/`SIGTERM` call `close()`: timers cleared, naming aborted, detached `git` killed, every session stopped (a cut-short turn queues `RESTART_PROMPT` for next time), sockets terminated, listeners closed, store closed, lock released. A second signal exits at once.

### Main listener routes (`app.ts`)

Middleware order: `markDaemon` (`x-tenzo-daemon: 1` on every response, so `expose` can recognise Tenzo itself) → `securityHeaders` → `accessGuard` → auth (for `/ws` and `/api/*` only).

| Route | Who | What |
|---|---|---|
| `GET /health` | anyone allowed by Host | `{ ok, version, environmentId }` |
| `POST /api/commands` | local or paired | One `Command` (JSON only, 415 otherwise), parsed with zod, run by `executeCommand` (`commands.ts`). 400 for the client's mistakes, 500 for ours. |
| `GET /api/session` | anyone | `{ mode: local\|remote, device }`: whether this browser is the Mac, paired, or neither. `no-store`. |
| `POST /api/pair` | anyone | Trades a pairing code for a device token, set as the `__Host-tenzo` cookie ([§13](#13-remote-access-and-security)). |
| `GET /api/attachments/:thread/:file` | local or paired | A screenshot copy (`attachments.ts` `storedAttachment`), with `nosniff`, `CSP: default-src 'none'; sandbox`, immutable caching. |
| `/api/*` (other) | | 404 JSON |
| `/live`, `/live/*` | | 404: live apps are only on the live listener. |
| `GET /ws` | local or paired | WebSocket ([§8](#8-protocol)), handlers in `socket.ts`. |
| everything else | anyone | The built web app (`serveStatic`), `_app/immutable/*` cached for a year, everything else `no-cache`; extension-less paths fall back to `index.html` (SPA). |

### Access guard (`access.ts`)

Applied to every request on both listeners, against DNS rebinding and cross-site requests (a WebSocket has no CORS preflight):

- **Host** must name loopback (`127.0.0.1`, `localhost`, `[::1]`) or a `TENZO_ALLOWED_HOSTS` name; else 403.
- **Origin** (on `/ws` and `/api/*` of the main listener; on everything on the live listener) must be absent (CLI, curl), the exact host:port the request came in on over `http` for loopback, an allowed host over `https` whose host:port equals the `Host` header (Tailscale Serve on any port), or a `TENZO_DEV_ORIGIN`. Other localhost ports are refused.

### Auth: local or remote (`auth.ts`)

`requestMode` says **local** only when all three hold: the socket's peer is loopback, `Host` names loopback, and no proxy forwarding header is present (`Forwarded`, `X-Forwarded-*`, `X-Real-IP`, `Via`, `Tailscale-User-*`, `Tailscale-App-Capabilities`). Tailscale Serve connects from 127.0.0.1 but adds `X-Forwarded-For` and passes the tailnet `Host`, so its requests are remote. Spoofing only makes a request remote.

`callerOf` (`app.ts`): local → `{ mode: "local" }`; remote → the device whose `__Host-tenzo` cookie verifies (every value under that name is tried), and only when `Sec-Fetch-Site` is `same-origin`, `none` or absent (`fromOwnPage`), so a same-site live page can't use it. No caller: 401 on `/ws` and `/api/*`, except `/api/session` and `/api/pair`. The web app's files stay public (they hold no data), so an unpaired phone gets the "Pair this device" page.

### Security headers

`securityHeaders` on every main-listener response: `Content-Security-Policy: frame-ancestors 'none'` (merged into an existing CSP), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. No page may frame the Pass (a live page is same-site, and on the Mac any website could frame the login-free Pass).

### Commands (`commands.ts`)

`executeCommand` is the single entry for both transports (`POST /api/commands` and `command` frames on `/ws`); it never throws. A `TenzoError` (`errors.ts`) is the client's fault and its message is the answer; anything else is logged and reported as a daemon failure. `device.*` and `daemon.settings` run against `Devices`/`Push` with the caller (`device.pair` and `daemon.settings` are local-only; `device.subscribe`/`unsubscribe` are paired-device-only); everything else maps onto an `Engine` method. `thread.watch`/`thread.unwatch` are answered by `socket.ts` itself (WebSocket only).

## 4. Storage

Everything lives under `$TENZO_HOME` (default `~/.tenzo`, created 0700):

| Path | What |
|---|---|
| `environment-id` | This machine's stable identity (`env_` + 20 chars), stamped on every record and every event. |
| `tenzo.db` | SQLite (`node:sqlite`, WAL). |
| `daemon.pid` | The home lock. |
| `worktrees/<project>/<thread-id>/` | Thread worktrees. |
| `attachments/<thread-id>/` | Copies of screenshots the agent attached (`att_….png` etc.). |
| `push-keys.json` | VAPID key pair, 0600. |
| `automations.paused` | The automations off switch: exists = paused. |
| `daemon.log` | Output of the launchd service (`tenzo service`). |

### Schema by migration (`db.ts` `MIGRATIONS`)

Migrations run in order, each once, all-or-nothing in one `BEGIN IMMEDIATE` transaction with foreign keys checked before commit; the count lives in `PRAGMA user_version`. A database newer than the code refuses to open. Shipped migrations are never edited, only appended.

| # | Name | Adds |
|---|---|---|
| 1 | projects and threads | `projects` (id, unique name, unique path, default_branch); `threads` (project, title, slug unique per project, branch, worktree_path, status active/archived, timestamps). |
| 2 | agent session per thread | `threads.agent`, `threads.session_id` (to resume). |
| 3 | event store, items and prompt queue | `environment_id` and `removed_at` on projects; `environment_id`, `model`, and projections `live`, `turn_id`, `context` on threads; `events` (append-only: triggers abort UPDATE and DELETE), `items`, `prompts` (the per-thread queue, with an optional standing `reply`). |
| 4 | unfinished names and create keys | `threads.naming` (prompt still owed a title), `client_key` (unique), `client_request`: idempotent `thread.create`. |
| 5 | thread phase | `threads.phase` (default `discussing`; existing threads with a session became `building`). |
| 6 | finished work | `threads.attachments` (JSON, pending for the next report), `threads.preview` (exposed `{port, path}`). |
| 7 | error items | `threads.turn_prompt`, `threads.turn_error` (what Retry sends, and why it failed). |
| 8 | landing and agent threads | `threads.wake` (JSON `{at, why}`), `origin` (user/agent), `parent_id`; index on `events.type`. |
| 9 | thread model override | `threads.thinking` (the thread's own thinking level). |
| 10 | automations | `threads.automation`; `automations` (project, name, schedule_key, next_run_at); `automation_runs` (trigger, result, reason, thread, budget, deadline_at, cap_usd, cost_usd, finished_at). |
| 11 | paired devices | `devices` (token_hash only, last_seen_at, revoked_at), `pairings` (code_hash, expires_at, used_at), `auth_keys` (the live-pass HMAC key). |
| 12 | web push | `devices.push_muted`; `push_subscriptions` (one per device: endpoint, p256dh, auth). |

### The log and its projections

- **`events` is the source of truth.** Every normalized runtime event ([§5](#event-vocabulary-packagescontractssrcruntimets)) is appended with its thread, type, turn, request id and JSON body, ordered by `seq`. Never updated, never deleted.
- **`fold.ts` is a pure function** `foldEvent(state, event) → { state, changes }` over a thread's runtime (`live`, `agent`, `sessionId`, `turnId`, `context`, `phase`, `attachments`, `preview`, `wake`, `prompt`, `error`) and its open items. Folding a thread's whole log from the start gives the same state and items (`foldEvents`): that is what makes the log authoritative. Item ids are derived from request ids (`itm_` ↔ `req_`), and error items' request ids from the event that opened them, so a replay produces identical ids.
- **`event-store.ts` `appendEvent`** appends the event, folds it, and writes the new runtime columns on `threads` plus every item change, in one transaction: the projection can never drift from the log, and a restarted daemon reads back exactly what it showed. A request id seen before never opens a second item.
- **Prompt queue** (`prompts` table): prompts wait here while a turn runs, survive restarts, and can carry a standing reply ([§7](#7-items-and-the-pass)). `enqueuePrompt(..., { first: true })` puts one ahead of all (used for `RESTART_PROMPT`).
- Transcripts stay Claude's (`~/.claude/projects/`); Tenzo keeps only its own events, with tool outputs cut to 2,000 characters (`claude-events.ts` `OUTPUT_LIMIT`).

## 5. The agent layer

### Adapter interface (`agent/agent.ts`)

The boundary between Tenzo and a coding agent. Above it there are only runtime events and these calls; nothing above `apps/daemon/src/agent/` knows it is Claude.

- `AgentAdapter.start(StartSessionInput) → AgentSession`. Input: thread id, `cwd` (the worktree), `resumeSessionId`, `restarted`, per-phase `models`, optional `permissionMode`, optional spend `budget`, `phase`, `attachmentsDir`, `pendingAttachments`, the thread `prompts`, and a `SessionHost` (`phase()`, `checkLanded()`, `startThread()`) for tools that need the daemon.
- `AgentSession`: `sessionId`, `events` (async iterable of `RuntimeEvent`), `sendTurn(prompt) → TurnId` (one turn at a time), `respondToRequest`, `respondToUserInput`, `respondToProposal`, `reconfigure(settings) → "unchanged" | "restart" | Promise`, `backgroundWork`, `interrupt()`, `stop()`.
- `agent/fake-agent.ts` and `agent/claude-testing.ts` are test doubles; tests never spawn `claude`.

### Claude adapter (`agent/claude.ts`)

Runs `query()` from `@anthropic-ai/claude-agent-sdk` with:

| Option | Value | Why |
|---|---|---|
| `pathToClaudeCodeExecutable` | `findClaude()`: `TENZO_CLAUDE_PATH`, else first `claude` on `PATH`, else `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin` | Your own binary and login. Looked up per session start. |
| `settingSources` | `["user", "project", "local"]` | Everything the terminal loads: settings, CLAUDE.md, subagents, skills, hooks, MCP servers, plugins. |
| `systemPrompt` | `{ type: "preset", preset: "claude_code", append: <phase prompt> }` | Claude Code's own prompt, with Tenzo's appended, never replaced. |
| `mcpServers` | `{ tenzo: tenzoMcpServer(...) }` | Added beside your servers (in-process SDK transport, `alwaysLoad`, 24-day tool timeout). |
| `permissionMode` | only when the project config sets one | Otherwise your own `defaultMode` applies ([§14](#14-product-decisions-recorded-in-code)). |
| `canUseTool` | Tenzo's hook | Tenzo tools: allowed. `AskUserQuestion`: becomes a question item. Anything Claude asks permission for: a permission item. |
| `env` | `claudeEnv(process.env)` + `TENZO_LIVE_BASE=/live/<thread>/` + `CLAUDE_CODE_SUBAGENT_MODEL` if configured | Strips a parent Claude Code session's variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_SSE_PORT`, `CLAUDE_CODE_BRIDGE_*`, `CLAUDE_EFFORT`, …); keeps your config (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, proxies). |
| `sessionId` / `resume` | new UUID, or the stored session id | Threads resume Claude's own conversation. |
| `model`, `thinking`/`effort` | from `models[phase]` (`modelOptions`) | `thinking: off` → `thinking: {type: "disabled"}`; `low/medium/high` → `effort`. |
| `maxBudgetUsd` | automation runs only: cap − spent (min $0.01) | Claude stops the turn itself (`error_max_budget_usd`). |

**Live switches vs restarts.** Before every turn the engine computes the thread's settings (`#settingsOf`: config read now, thread override, phase, budget) and calls `session.reconfigure`. `planSwitch` decides:
- live, in place: another named model (`setModel`), back to your own model (`setModel(ownModel())`, from `ANTHROPIC_MODEL` or your settings via Claude's `get_settings`), another effort level (`applyFlagSettings({effortLevel})`), thinking off (`setMaxThinkingTokens(0)`);
- `restart`: thinking back on after off, another permission mode, another subagent model, another spend cap. The engine ends the session at the turn boundary and starts a new one resuming the conversation (`restarted: true`).

The turn waits for a switch up to 15 s (`switchTimeoutMs`); a switch that isn't confirmed becomes one restart, and a restarted session that still doesn't confirm runs the turn as is with a `runtime.error` note. A session that won't stop within 15 s is abandoned; its queued prompts go on an error card whose Retry sends them. *Build it* switches to the build model inside the same turn (`propose` awaits `switchTo(models.build)` before returning).

**Background work.** The adapter counts Claude's `background_tasks_changed` tasks that are real work (`isWork`: non-ambient, or a Monitor). While any run, or while Claude is in a turn it started itself, the engine never restarts the session (`#canRestart`); the change waits for a clean turn boundary or the session's natural end. Sessions stay up between turns so background work keeps reporting.

**Stop.** `stop()` closes the input stream (Claude finishes and exits), waits 5 s, then `run.close()`. Open requests are settled as `ended`: no `*.resolved` event, and the daemon keeps them as detached items.

### SDK messages → events (`agent/claude-events.ts`)

`translate(state, message)` is pure. `system/init` → `session.started` (first time) and `session.configured` (first time and when the model changes; tools, MCP servers with status, skills, plugins, agents, permission mode, version). `assistant` text/thinking → `item.completed` (`assistant_message`/`reasoning`); `tool_use` → `item.started` (with `toolKind`, a one-line summary, bounded input). `user` tool results → `item.completed` with output cut to 2,000 chars. `result` → `turn.completed` (state, result text, `costUsd` = Claude's session total, duration, `stoppedBy: "budget"`), preceded by `runtime.error` when failed. A turn Claude starts by itself (a background task reporting) is opened as a synthetic `turn.started` without a prompt; our prompt's UUID is the turn id, which Claude echoes on its result, so results of other turns don't close ours (`isForAnotherTurn`). Requests carry a SHA-256 **fingerprint** over the tool name and its full input (`agent/fingerprint.ts`), taken before anything is cut for display.

### Event vocabulary (`packages/contracts/src/runtime.ts`)

| Event | From | Fold effect |
|---|---|---|
| `session.started` | adapter | `live`, `agent`, `sessionId` |
| `session.configured` | adapter | none (shown in the timeline; parity reads it) |
| `session.exited` | adapter, or daemon on restart/abandon | not live; open asks become **detached**; `exitKind: error` mid-turn with nothing asked → error card `crash` |
| `turn.started` | adapter | turn, prompt; clears context; a prompt of ours resolves open error cards (not config cards) as `recovered` |
| `turn.completed` | adapter | closes the turn; `failed` → error card `turn` |
| `item.started` / `item.completed` | adapter | top-level assistant text becomes the next item's `context` (trimmed to 280 chars) |
| `request.opened` / `request.resolved` | adapter (daemon when delivering to a detached item) | permission item opened / resolved |
| `user-input.requested` / `user-input.resolved` | same | question item |
| `proposal.requested` / `proposal.resolved` | same | proposal item; `build` → phase `building` |
| `attachment.added` | adapter (`attach`) | pending attachments |
| `preview.exposed` | adapter (`expose`) | `preview` |
| `report.submitted` | adapter (`report`) | finished item (supersedes the previous one); phase `review` if building/review |
| `report.resolved` | daemon | `merge`/`pr` → `landing`; `changes` → `building` |
| `merge.ready` / `merge.resolved` | adapter / daemon | ready item (one per thread) |
| `wake.scheduled` / `wake.fired` | adapter / daemon | `wake` set / cleared |
| `thread.landed` | adapter (`landed`) | none; the engine archives at turn end |
| `landing.stuck` | daemon | error card `stalled` or `unarchived` (one at a time) |
| `budget.exceeded` | daemon | error card `budget` (one at a time) |
| `config.checked` | daemon | error card `config`, or resolves it when `problem` is null |
| `error.resolved` | daemon | error card resolved (`retried`, `told`, `acknowledged`) |
| `item.snoozed` / `item.unsnoozed` | daemon | `snoozedUntil` set / cleared |
| `thread.archived` | daemon | all open items `dismissed`; not live; no preview, no wake |
| `runtime.error` | adapter or daemon | records the turn's error; with no session and no turn, error card `start` (accumulating `unsent` prompts) |

### The injected `tenzo` MCP server (`agent/tenzo-mcp.ts`)

Tools only describe and validate; their behaviour is the session's (`TenzoToolHost` in `claude.ts`). Tenzo's tools never ask the user for permission (`isTenzoTool` in `canUseTool`).

| Tool | Waits? | Semantics and guards |
|---|---|---|
| `propose(summary, headline?)` | yes, until you answer | Opens a proposal card. Only one pending per session. Build it → result is `"Approved, build it."` + the build prompt, phase becomes building, build model switched in. Change → "Not yet. <note> Revise, and propose again." |
| `report(summary, how_to_test, checks[], headline?)` | no | Refused while discussing ("propose first") and while landing. Emits `report.submitted` with pending attachments and the live preview; resets the attach count. |
| `attach(path, caption?)` | no | PNG/JPEG/GIF/WebP by magic bytes, ≤ 10 MB, inside the worktree after resolving symlinks, re-checked on the open file (same inode, no hard links), ≤ 8 per report (`attachments.ts`). Copied to `$TENZO_HOME/attachments/<thread>/`. |
| `expose(port, path?)` | no | Port 1024–65535; something must answer at `localhost:<port>/live/<thread>/<path>`; refused if it is Tenzo (`x-tenzo-daemon`); the listening process must run inside the worktree (`lsof`; unchecked without lsof). Warns when the page references assets outside the base. |
| `wake_me(in, why)` | no | 1 minute to 7 days (`parseWait`). One wake per thread; a new one replaces it. Survives restarts. |
| `ready_to_merge(url, summary, headline?)` | no | Landing phase only; http(s) URL. Opens a quick-lane ready card with Merge. |
| `landed(url, summary?)` | no | Landing phase only. `host.checkLanded()`: clean worktree, and after `git fetch origin <default>` (30 s timeout, no credential prompts) `git merge-tree --write-tree origin/<default> HEAD` equals `origin/<default>`'s tree (`git.ts` `landedOn`; holds after merge, squash and rebase). Then `thread.landed`; the engine archives at turn end. |
| `start_thread(prompt, project?, title?)` | no | Ordinary create with origin `agent` and the parent recorded. Refused for a thread an agent started; at most 10 per thread ever (`MAX_CHILD_THREADS`), at most 10 agent-started threads active at once (`MAX_AGENT_THREADS`). |

### Thread prompts (`apps/daemon/prompts/`, `prompts.ts`)

Plain Markdown, HTML comments stripped (`cleanPrompt`), read at every session start so an edit applies to the next session. `promptFor(phase)`: `discuss.md` while discussing, `build.md` while building or in review, `landing.md` while landing. A system prompt is fixed for a session's life, so the answer that changes phase carries the next prompt: the approval carries `build.md` (`proposalReply`), Merge and Open PR carry `landing.md` (`reviewPrompt`). There is no automation prompt file: an automation run's first prompt is built by `runPrompt` in `automations.ts` ([§12](#12-automations)).

## 6. Thread lifecycle

### Phases

`ThreadPhase` (`queue.ts`) is `discussing | building | review | landing`; `archived` is the thread's `status`, not a phase.

```
create ─▶ discussing ──propose → Build it──▶ building ──report──▶ review
                                               ▲                    │
                                               │ Needs changes      │ Merge / Open PR
                                               └────────────────────┤
                                                                    ▼
                                                                 landing ──landed + turn end──▶ archived
```

- **Create** (`engine.createThread` → `threads.ts` `createThread`): resolve the default branch's commit (`resolveBase`: local branch, else `origin/`), pick a slug (`slug.ts`; `-2`, `-3` if the project has it as a thread or a `tenzo/<slug>` branch), `git worktree add --no-track -b tenzo/<slug> -- <path> <base>`, insert the row (undoing the worktree and branch if that fails). `clientKey` makes it idempotent across restarts; the same key with a different request is refused. Without a title, the prompt's first words stand in (`quickTitle`) and a one-shot `claude` on haiku (no tools, no settings, not persisted, 30 s timeout) names it later (`titles.ts`).
- **Prompts** go through the queue: `#pump` sends the next prompt when no turn of ours runs, starting or resuming the session as needed. A session that can't start drops the queue into an error card `start` whose Retry resends them.
- **Archive** (`engine.archive`): refuses before stopping anything if the worktree has uncommitted changes (unless `force`) or the repo is gone; stops the session, `git worktree remove` (branch kept), clears prompts, wake and budget timers, finishes the automation run, deletes attachment copies, appends `thread.archived`. With `--force` and a vanished repo, only Tenzo's own `worktrees/<project>/<id>` folder is deleted, after path checks.
- **Landed**: after `thread.landed`, the turn's end triggers `#archiveLanded`. If you sent a message meanwhile, or archiving fails, the thread stays landing with an `unarchived` card; `send` to a landed thread is refused. A landing turn that completes with no wake, no open card, nothing queued and no `landed` gets a `stalled` card (`#checkStalled`) whose Retry sends `STALLED_PROMPT`.
- **Projects** (`projects.ts`): `addProject` reads the repo (`git rev-parse` top level, default branch from `origin/HEAD`, else `main`/`master`, else HEAD) and writes nothing into it. `removeProject` refuses while threads are active and only hides the project (`removed_at`); adding it again restores it.

### Restart behaviour

| Situation | What happens |
|---|---|
| Daemon stops (signal) mid-turn | Session stopped; if the turn was cut short (running, not waiting on you) `RESTART_PROMPT` is queued first; next start resumes it. |
| Daemon killed mid-turn | On start, `session.exited` is recorded for every `live` thread; same resume rule; a second interruption of a resumed turn gives an error card instead. |
| A question/permission/proposal was open | It stays on the Pass, `detached: true`. Answering appends the `*.resolved` event and queues `deliveryPrompt` ("Your session ended while you were waiting for my answer…", or "I allow it. Go ahead…") with a standing reply ([§7](#7-items-and-the-pass)). |
| Claude crashes mid-turn | `session.exited` with `exitKind: error` → error card `crash`, unless the turn was waiting on you. |
| Turn fails | error card `turn`. Retry sends `carryOn` ("Your last turn didn't finish: … Check what is already done…"), never the original prompt again. |
| Wakes, snoozes, budgets, schedules | Kept in the log/DB, re-armed on start; times already past fire immediately. |
| Stand-in titles | Named again on start. |

## 7. Items and the Pass

### Item kinds (`QueueItemKind`, made in `fold.ts`)

| Kind | Lane | Opened by | Options (`fold.ts`) | Answer (`ItemAnswer`) |
|---|---|---|---|---|
| `question` | quick | `user-input.requested` (`AskUserQuestion`) | the agent's options; `recommended` from "(Recommended)" in the label | per question id: option value(s) or free text |
| `permission` | quick | `request.opened` | Allow (suggested), Deny | allow / deny + optional reason |
| `proposal` | quick | `proposal.requested` | Build it | build / change + note |
| `finished` | review | `report.submitted` | Merge, Open PR, Done | merge / pr / done / changes + note |
| `ready` | quick | `merge.ready` | Merge | merge / changes + note |
| `error` | quick | fold, for causes `turn`, `crash`, `start`, `stalled`, `unarchived`, `config`, `budget` | Retry + Archive; config: Retry + Dismiss; budget: Continue (retry) + Stop (archive) | retry / tell + text / archive / dismiss (config only) |

Budget and config cards are error items with their own cause, not kinds of their own. Each item carries `context` (the agent's last words, ≤ 280 chars), `ask`, `options`, `suggested`, its kind's payload, an optional `fingerprint`, `detached`, `snoozedUntil`, and once resolved a `resolution` (`answered`, `allowed`, `denied`, `approved`, `revise`, `cancelled`, `dismissed`, `done`, `merge`, `pr`, `changes`, `superseded`, `retried`, `told`, `recovered`, `acknowledged`).

**Lanes.** Quick-lane items (the agent is stuck waiting) come before review-lane items on the Pass (`apps/web/src/lib/pass.ts` `pileOf`: by lane, then age). Only quick-lane items push to phones.

### Answer delivery (`engine.answer`, `answers.ts`)

`checkAnswer` validates and tidies the answer for the item's kind. Then:
- **live**: question, permission or proposal with the asking session still up → handed to the session; the call waits up to 10 s for the `*.resolved` event.
- **message**: the asking session has ended (detached), or the item is finished/ready/error → the resolution event is appended and a prompt queued in one transaction, then pumped. Finished: `reviewPrompt` (Merge/Open PR carry `landing.md`; Done sends nothing → `none`); ready: `mergePrompt`; error: `errorPrompts` (start/stalled/unarchived/budget resend their stored prompts, others send `carryOn`, tell sends your words; a budget Continue also grants more budget).
- **none**: Done, or a config card's Retry/Dismiss (Retry re-reads the config and reconfigures a live session).
- **archived**: Archive (Stop on a budget card).

**Fingerprints and auto-answer after restart.** When an answer to a detached ask is delivered as a message, a **standing reply** (`StandingReply`: kind + fingerprint + answer) rides with the queued prompt. If the resumed agent asks exactly the same thing in that turn (same fingerprint of tool name and full input), the engine answers it from the standing reply and never shows the card (`#quiet`); anything that differs anywhere is asked again.

**Snooze.** `item.snooze` appends `item.snoozed` with `until = now + TENZO_SNOOZE_MS` (default 15 min); a per-item timer appends `item.unsnoozed` (`returned`) at that time, also after restarts; `item.unsnooze` (Undo) appends it with `undo`. The daemon's clock decides; clients only count down using their clock offset. A thread whose open items are all snoozed shows `activity: "snoozed"`.

**Suggested answers.** The filled button is `suggested` (questions: the recommended option, else the first, `client-runtime` `suggestedOption`). On finished cards the filled button is the project's landing rule (`merge` or `pr`, `pass.ts` `stepsOf`), but `suggestedAnswer` (what "take every suggestion" sends) is **Done**, and the CLI merges only on the word `merge`: landing is never a reflex.

## 8. Protocol

All shapes are zod schemas in `packages/contracts`; both ends validate on arrival.

### WebSocket `/ws` (`frames.ts`, daemon side `socket.ts`)

| Direction | Frame | Meaning |
|---|---|---|
| daemon → | `hello` | `environmentId`, `version`, `serverTime` (client computes its clock offset) |
| daemon → | `snapshot` | `Snapshot`: active threads, open items (minus quiet ones), projects, `live` (with a paired device's Open live grant), automations, `automationsPaused`, `automationProblems`. Replaces client state. |
| daemon → | `thread` | a `ThreadView` as it is now (archived → leaves the list) |
| daemon → | `item` | `change` (`opened`, `updated`, `detached`, `snoozed`, `unsnoozed`, `resolved`) + the item |
| daemon → | `automations` | the whole automations state |
| daemon → | `live` | a fresh Open live grant, every 20 min for paired devices |
| daemon → | `event` | one new `StoredEvent` of a thread this socket watches |
| daemon → | `ok` / `error` | answer to a command by its id (`error` with `id: null` for an unreadable frame) |
| daemon → | `pong` | answer to `ping` |
| client → | `command` | `{ id, command }` |
| client → | `ping` | liveness |
| client → | `visibility` | the page is in view or not (suppresses push to that device) |

Hello and snapshot are sent and the engine subscription made in one tick, so nothing is missed or doubled. There is no replay: a client that reconnects gets a fresh snapshot. A socket with more than 4 MB unsent is terminated; frames over 1 MB are refused; a revoked device's sockets close with code 4401. `thread.watch` answers with a backlog (up to 200 latest events, or those after `after` when few enough, with `older` and `reset` flags) and then streams `event` frames in log order; at most 16 watches per socket.

### Commands (`commands.ts` in contracts)

| Command | Does |
|---|---|
| `thread.create` | project, title and/or prompt, model, `clientKey` |
| `thread.send` | queue a prompt |
| `thread.archive` | optional `force` |
| `thread.list` | optional project, `includeArchived` |
| `thread.events` | page of events (`after`, `before`, `limit` ≤ 500) |
| `thread.watch` / `thread.unwatch` | WebSocket only |
| `thread.setModel` | thread's own model/thinking (null: config decides) |
| `thread.diff` | `git diff --numstat` vs the default branch plus untracked files (`diff.ts`; ≤ 300 files listed) |
| `project.list`, `snapshot` | |
| `item.answer`, `item.snooze`, `item.unsnooze` | |
| `automation.list`, `automation.run`, `automation.pause`, `automation.archiveFinished` | |
| `device.pair` (local only), `device.list`, `device.rename`, `device.revoke`, `device.subscribe` / `device.unsubscribe` (paired device only), `device.mute`, `device.testPush` | |
| `daemon.settings` (local only) | the daemon's `TENZO_PUBLIC_URL`, allowed hosts, live origins (for `tenzo pair --tailscale`) |

Results are typed per command in `CommandResults`. Over HTTP the response is `{ ok: true, result } | { ok: false, error }`.

### HTTP API

See the route table in [§3](#main-listener-routes-appts). The CLI's client (`apps/daemon/src/client.ts` `callDaemon`) posts commands to `http://127.0.0.1:TENZO_PORT/api/commands` and parses the typed result.

## 9. client-runtime

`packages/client-runtime/src`, framework-free:

- **`Connection`** (`connection.ts`): the one owner of the WebSocket. `connected` only after the daemon's `hello`. Reconnects with capped exponential backoff plus jitter (500 ms → 15 s; the attempt count resets only after 30 s up). Hello timeout 10 s; ping every 15 s, dead after 10 s without any frame. **Wakeups** (`visibilitychange`, `pageshow`, `online`): a page away ≥ 30 s replaces the socket at once; otherwise a probe ping with a 3 s timeout, during which `probing` marks data as possibly stale. `clockOffset` = daemon clock − device clock from each hello. Frames are validated against `ServerFrame`.
- **`TenzoClient`** (`client.ts`): keeps `Data` (threads, items, projects, live, automations) current via the pure reducer `applyFrame` (`state.ts`: snapshot replaces, thread/item upsert or remove, idempotent). `synced` is true only when this connection's snapshot arrived and no probe is out. `command(...)` sends over the socket and resolves with the typed result; `CommandError` reasons `offline` (never sent; commands are never queued), `lost` (sent, socket dropped: may or may not have run), `rejected`, `invalid`. `setVisible` sends `visibility` frames. `watch(threadId, listener)` manages `thread.watch`, re-watching after reconnects.
- **Feeds** (`feed.ts`): a watched thread's events, at most 2,000 kept; `applyBacklog`, `appendLive`, `prependOlder` (pages of 200 via `thread.events` with `before`).
- **`session.ts`**: `fetchSession()` (`GET /api/session`) and `pairBrowser()` (`POST /api/pair`).
- **`answers.ts`**: `suggestedOption`, `suggestedDecision`, `suggestedAnswer`.

## 10. The web app

`apps/web`. One `TenzoClient` for the whole app (`src/lib/tenzo.svelte.ts`), opened by the layout after `GET /api/session` says this browser is local or paired; an unpaired remote browser gets `PairDevice.svelte` and opens no socket. A socket that keeps failing re-checks the session and falls back to pairing if the device was revoked. The socket URL switches to `wss:` under HTTPS.

### Routes (`src/routes/`)

| Route | Screen |
|---|---|
| `/` | **The Pass** (`+page.svelte`): the pile (`Card.svelte` on top, up to 4 edges behind), the all-clear card with *Meanwhile* (`AllClear.svelte`), snooze toast with Undo (`SnoozeToast.svelte`), `?item=<id>` focuses a card (notification taps). |
| `/new` | New thread: prompt, project picker (remembered per browser), dictation, `clientKey` per draft; the draft survives closing. |
| `/threads` | Threads list in groups Needs you / Working / Landing / Today / Earlier, one status word per thread, origin markers; rows slide between groups. |
| `/threads/[id]` | One thread's timeline (`Timeline.svelte`), live while open, with the "⋯" model menu (`ModelMenu.svelte`). |
| `/automations` | Automations list: schedule in words, next/last run, Run now, archive finished runs, the off switch, broken configs. |
| `/devices` | Paired devices: rename, revoke, notifications on/off, mute, test. |
| `/pair` | Pairing link landing: reads the code from the fragment, removes it from history, pairs. |

### Pure logic modules (`src/lib/*.ts`, each with a `*.test.ts`)

| Module | Does |
|---|---|
| `pass.ts` | pile order (lane, then age), pile edges, card steps and buttons per kind (`stepsOf`, landing rule), snooze labels |
| `answering.ts` | answering one card as a state machine; ignores taps for 350 ms after a card or question appears, and after an answer went |
| `back.ts` | back of the card: *why it's asking*, *the change* (`thread.diff`), or the error's context |
| `timeline.ts` | events → readable rows (prompts, replies, asks and answers, folded tool runs), paging window |
| `threads.ts` | Threads list groups, tones and status words |
| `meanwhile.ts` | the all-clear's working threads and snoozed items |
| `finished.ts` | finished card: badges, screenshots, live link |
| `automations.ts` | automations list rows and run outcomes |
| `motion.ts`, `flip.ts` | card arrive/lift/swipe motion and card flip; reduced-motion aware |
| `swipe.ts`, `swipeable.ts` | swipe-to-snooze gesture as a pure function, and its pointer wiring |
| `trail.ts`, `nav.ts` | the app's own history trail, so Close goes back to the Pass the way the back gesture would |
| `markdown.ts` | a small, escape-everything Markdown renderer for agent text |
| `notifications.ts` | what the service worker shows, where a tap goes, which notifications to clear (pure; used by the SW) |
| `push.ts` | browser push support detection, subscribe/unsubscribe, Devices view lines |
| `model.ts`, `devices.ts`, `projects.ts`, `create-key.ts`, `speech.ts`, `viewport.ts`, `status.ts` | model menu, device lines, project memory, idempotency keys, dictation, iOS keyboard viewport, connection label |

### Service worker (`src/service-worker/index.ts`)

Notifications only: caches nothing, handles no fetch. `push` → `showNotification` (every push shows one, or iOS ends the subscription); `notificationclick` → focus an open window and `postMessage` the card's URL, else open one; `pushsubscriptionchange` → re-subscribe with the same key and `POST /api/commands` `device.subscribe` with the page's cookie. The app also re-sends its subscription on each open and clears notifications of threads that no longer need you.

## 11. Project config

`.tenzo/config.json` (committed) and `.tenzo/local.json` (personal, gitignored), both optional, in the project's **main checkout**, never written by Tenzo. Schema: `ProjectConfig` (`packages/contracts/src/config.ts`), strict keys. Reading: `apps/daemon/src/project-config.ts`.

```json
{
  "agent": "claude",
  "models": {
    "discuss": { "model": "opus", "thinking": "high" },
    "build":   { "model": "sonnet", "thinking": "medium" },
    "agents":  { "model": "haiku" }
  },
  "permissions": "acceptEdits",
  "landing": "pr",
  "automations": { "<name>": { "prompt": "…", "trigger": { "schedule": "every 1h" } } }
}
```

- **Safe reading** (`readConfigFile`): `.tenzo` must be a real folder; each file a plain file (no symlink, device, pipe), resolving inside the repo, ≤ 64 KB, opened with `O_NOFOLLOW | O_NONBLOCK` and re-checked with `fstat`.
- **Merge**: `local.json` over `config.json`, deep, key by key; the merged automations must each have a prompt.
- **Cache** (`ProjectConfigs`): re-read only when an `lstat` stamp of the folder or either file changes. The engine reads it before every turn and at every session start, so edits apply from the next turn without a restart.
- **Permission ceiling**: `permissions` may be only `default`, `acceptEdits` or `dontAsk` (`PermissionModeName`). `auto` and `bypassPermissions` are refused with a message pointing to your own `~/.claude/settings.json` (Claude Code refuses them from repo settings too, and Tenzo passes the mode as a trusted flag). `plan` isn't offered.
- **Model precedence** (`resolveModels`), field by field: the thread's own choice (`thread.setModel`, `--model`, an automation's `model`/`thinking`) → `models.discuss`/`models.build` → `TENZO_DEFAULT_MODEL` (models only) → Claude's own. `models.agents.model` → `CLAUDE_CODE_SUBAGENT_MODEL` (used only when the subagent names no model). With no config, nothing is passed.
- **Landing rule**: `landing` (`merge` default, or `pr`) picks the finished card's filled button; exposed on every `ThreadView`.
- **Invalid config** never stops a thread: it runs on defaults, and the engine records `config.checked` with the problem, opening one config card per project (Retry re-reads, Dismiss hides it until the problem changes; it closes when a turn starts with the file fixed). Automations of a project with a broken config don't run.

## 12. Automations

Definitions live in the project config under `automations` (≤ 20 per project; names `[a-z0-9-]`, ≤ 40; prompt ≤ 8,000 chars). The daemon keeps only schedules and runs (`automations`, `automation_runs` tables). Code: `apps/daemon/src/automations.ts` (scheduler, prompt, DB), budgets in `engine.ts`, schedule parsing in `packages/contracts/src/schedule.ts`.

- **Triggers** (`parseSchedule`): `every Nm|h|d` (5 min to 30 days), `hourly`, `daily HH:MM`, `weekdays HH:MM`, or a 5-field cron (Vixie-style day matching), in `trigger.timeZone` (default the machine's; DST "compatible" handling). No schedule: run by hand only. `enabled: false` switches a schedule off.
- **Scheduler**: `Automations.tick()` looks at every project at the earliest due time, at least every 60 s and at most every 1 s. It recomputes `next_run_at` when the schedule key changes, fires what is due, and computes the next time before firing (`nextAfterFiring`), so missed runs while the daemon was down fire **once**. A schedule starts a run at most every 5 minutes. Removed automations and projects lose their schedules.
- **Caps**: a scheduled run is skipped (and recorded) while automations are paused (`$TENZO_HOME/automations.paused`, toggled by `tenzo automation pause|resume` / `automation.pause`) or when 3 runs are already going across all projects (`MAX_RUNS_GOING`). Any run is skipped while its previous run is going, waiting on you, or paused by its budget. Run now ignores the pause and the global cap.
- **A run is an ordinary thread** created through `Engine.#create` with origin `automation`, title `<name> · <Mon D HH:MM>`, the automation's model/thinking as the thread's own choice, and its run row (with budget) inserted before the session starts. It goes through discuss like any thread; no approval gate stands before a scheduled run starts.
- **Memory between runs** (`runPrompt`): the automation's prompt, then which automation and trigger this is, the previous run's last words (its latest report, else last answer; ≤ 1,500 chars, quoted), and where the notes file `.tenzo/automations/<name>.md` is newest (found by a read-only `git log` over the default branch and earlier runs' branches, 10 s timeout; if the worktree lacks it, a `git checkout <commit> -- <path>` instruction). The agent may update and commit that one file without proposing; it is asked to leave markers in external systems.
- **Budgets** (default 1 h and $2; at most 24 h and $20 from the file): `deadline_at` = start + wall clock, `cap_usd`; Claude gets `maxBudgetUsd` = cap − spent. Over either (checked at turn end, at the wall-clock timer, and before sending a turn), the run is paused: `budget.exceeded` opens a quick-lane card, a running turn is interrupted (one waiting on your answer is re-checked a minute later), nothing more is sent. **Continue** grants one more budget from now (deadline = now + wall clock; cap = max(spent, old cap) + cost), which needs a new session for the new cap; **Stop** archives. Never a kill without asking. A run's budget stops applying once the run is finished (`finished_at`).
- **Run state** (`#runState`): `paused`, `waiting`, `going` (working or landing), `finished` (nothing running or queued, nothing open but finished work), `archived`.
- **Auto-archive**: when a new run starts, the previous run is archived if finished, with no open item, a clean worktree and no commits beyond its base (`#retireRun`); its branch stays. `automation.archiveFinished` archives all finished runs with clean worktrees.

## 13. Remote access and security

Setup steps are in [REMOTE.md](REMOTE.md); the README's "Remote access" and "Notifications" sections give the user-facing model. Here is the mechanism.

### Threat model in brief

The daemon can start agents that run code as you, so its API is guarded against: web pages in your own browser (DNS rebinding, cross-site requests, WebSockets without preflight, framing), other devices on the network or tailnet (pairing + device token), live pages served by agents (a separate origin and credential), push-endpoint SSRF (allowlist), and the repo itself (config can't raise permissions; automations are bounded). Whoever sits at the Mac is trusted (no login locally).

### Pairing and devices (`devices.ts`, `auth.ts`)

- `tenzo pair` → `device.pair` (local only): a 26-char random code, 10 minutes, single use; only its SHA-256 is stored (`pairings`). Every `tenzo pair` lifts the failed-attempt limit.
- The link is `<TENZO_PUBLIC_URL>/pair#<code>`: the fragment never reaches a server, log or Referer. The page posts it to `POST /api/pair` (JSON, same origin); `exchange` creates a device with a fresh 256-bit token, stored as SHA-256 (`devices`).
- Failed exchanges are rate-limited to 10 per minute globally (behind Serve every request is 127.0.0.1); a good code is tried first and always pairs.
- The token travels only as `__Host-tenzo` (`HttpOnly; Secure; SameSite=Strict; Path=/`, 400 days). It needs HTTPS. `last_seen_at` is written at most once a minute. Revoking (`device.revoke`) stops the token and closes every open socket of the device (Pass and live) at once (`Devices.track`).

### Live origin isolation (`live.ts`)

- A second listener serves only `/live/<thread>/…`, proxying HTTP and WebSocket to the port the thread's agent exposed last (`engine.livePort`, active threads only). Paths are forwarded unchanged; `Host` and `Origin` are rewritten to `localhost:<port>`; hop-by-hop headers, `Service-Worker-Allowed` and `Clear-Site-Data` are dropped; `x-tenzo-live` marks forwarded requests and a request coming back with it is a loop (508).
- The main listener refuses the live origin (Origin check; `Sec-Fetch-Site: same-site` doesn't count as own page). The live listener never accepts `__Host-tenzo`, strips both Tenzo cookies from every request before it reaches a dev server, and drops any `Set-Cookie` for them, WebSocket handshakes included.
- Remote access to live apps takes only `__Host-tenzo-live`: an HMAC-signed pass `<device>.<expiry>.<mac>` (key in `auth_keys`), checked against revocation on every request. A paired device's snapshot carries a 1-hour grant, renewed over its socket every 20 minutes; Open live goes through the **door** `/_tenzo/live?grant=…&to=/live/<thread>/…`, which sets the live cookie (1 day, never past the device's own cookie) and redirects. An Open live link is personal for that hour.

### Push (`push.ts`)

- VAPID keys in `push-keys.json`; contact `TENZO_PUSH_CONTACT` (default the project page, so your tailnet name isn't sent).
- Subscriptions are accepted only for endpoints on known push services (`https`, default port, a host name under `googleapis.com`, `google.com`, `push.apple.com`, `push.services.mozilla.com`, `notify.windows.com`; no IP literals), checked on subscribe and before every send; keys must be a real P-256 point and a 16-byte secret.
- What pushes: open, awake, quick-lane items that opened or came back from a snooze. Per thread, a 3 s debounce makes one push for the newest unannounced card; tag = thread id. Not to muted devices, nor to devices whose page is in view (a `visibility` frame, stale after 45 s). `Urgency: high`, TTL 1 h, `Topic` = thread. Retries after 5 s, 30 s, 2 min (or `Retry-After`) while still relevant; 404/410 forget the subscription. Test pushes at most once per 10 s per device.
- Payload privacy: thread title (≤ 60) and one line (≤ 120): a question's text, "Allow <tool>?" (never the command or input), proposal/ready headlines; never context. `TENZO_PUSH_PREVIEW=none` reduces every push to "A thread needs you." The Mac itself doesn't push.

### Tailscale setup (`tailscale.ts`, `tailscale-setup.ts`)

`tenzo pair --tailscale` reads `tailscale status --json` and `tailscale serve status --json`, plans two HTTPS routes (default `:8443` → daemon port, `:8444` → live port; a port serving something else moves to the next free one), shows the exact commands and runs them after you confirm (`--yes` to skip). It never removes or changes other routes and never uses `--tcp`/`--tls-terminated-tcp` (`assertSafeServe`); it refuses while a raw TCP route points at Tenzo. It then aligns the daemon's `TENZO_ALLOWED_HOSTS`, `TENZO_LIVE_ORIGIN`, `TENZO_PUBLIC_URL` (editing only those keys of the launchd plist and restarting the service, or printing the restart command) and prints the pairing link and QR (`uqr`).

### Known limits

- **SSH tunnels count as local.** `ssh -L` to the daemon's port arrives from loopback with a loopback Host: that is the Mac's own login.
- **Raw TCP forwarding makes everyone local.** `tailscale serve --tcp`, `--tls-terminated-tcp`, `socat`, `ssh -R`, ngrok TCP add no forwarding headers and let a client send `Host: localhost`, so every client through them is local with no pairing. So does an HTTP proxy that rewrites Host to loopback and drops forwarding headers. Only `tailscale serve --https`.
- **No hard guard against pushing to the default branch.** Landing rules live in `landing.md` (a prompt); Tenzo installs no git hook and cannot stop an agent's `git push`. The mechanical checks are `--no-track` on thread branches and `landed`'s git verification. This is a user decision ([§14](#14-product-decisions-recorded-in-code)).
- **Live apps share one origin** with each other (not with Tenzo).
- **`expose`'s worktree check needs `lsof`**; without it the port is unchecked.
- **Cost figures are Claude's estimates** (`total_cost_usd`); a session that ended before saving its total can undercount a run.

## 14. Product decisions recorded in code

| Decision | Where it lives |
|---|---|
| Tenzo never sets the permission mode; your `defaultMode` applies in every phase. Discussing is held by `discuss.md` and `propose`, not by plan mode. Only an explicit project-config `permissions` (capped at `acceptEdits`/`dontAsk`/`default`) overrides. | `agent/claude.ts` (`permissionOptions`, module comment), `PermissionModeName`/`USER_ONLY_MODES` in `contracts/src/config.ts`, `project-config.ts` `parseFile` |
| No hard guard against pushing to the default branch: the landing rules are prompt rules, and Tenzo writes nothing into your repo. | `prompts/landing.md`; absence of any hook code; `projects.ts` (reads only) |
| No force-push, merges only through `gh pr merge` (no `--admin`), never approve own PR, PR comments are information. | `prompts/landing.md`, `prompts.ts` `mergePrompt` |
| `landed` is believed only when git agrees, so unmerged work never drops off the list. | `git.ts` `landedOn`, `engine.ts` `#checkLanded` |
| Automations start without an approval gate (a schedule just runs), bounded instead: budgets, 5-minute minimum gap, 3 runs at once, an off switch outside the repo, no permission mode from the repo. Runs still discuss before building. | `automations.ts`, `engine.ts` budget methods, `contracts/src/config.ts` `RUN_BUDGET` |
| Budgets pause and ask; never kill. | `engine.ts` `#pauseRun`, `budget.exceeded` |
| Landing is never a one-tap default: `suggestedAnswer` on finished work is Done; the CLI merges only on `merge`. | `client-runtime/src/answers.ts`, `daemon/src/answers.ts` `answerFromWords` |
| One thing at a time, briefs not transcripts: items carry ≤ 280 chars of context; tool output kept ≤ 2,000 chars; transcripts stay Claude's. | `fold.ts` `CONTEXT_LIMIT`, `claude-events.ts` `OUTPUT_LIMIT` |
| No fan-out from agents: agent-started threads can't start threads; 10 per thread, 10 active. | `engine.ts` `#startChild` |
| Your tools untouched: real `claude`, all setting sources, Tenzo's MCP server added beside yours. | `agent/claude.ts`, verified by `pnpm parity` |

## 15. Testing and verification

| What | Where | Runs in |
|---|---|---|
| Daemon unit and integration tests (engine with fake agents, fold, event store, migrations, access, auth, live proxy, devices, push, automations, schedules, config, git, CLI args, Tailscale planning with a fake runner, service plist) | `apps/daemon/src/**/*.test.ts` (33 files); fakes in `src/testing.ts`, `src/agent/fake-agent.ts`, `src/agent/claude-testing.ts` | `pnpm check`, CI |
| Contracts | `packages/contracts/src/*.test.ts` | `pnpm check`, CI |
| client-runtime (connection with fake sockets/timers, client store, feeds, state, session, answers) | `packages/client-runtime/src/*.test.ts`; helpers in `src/testing.ts` | `pnpm check`, CI |
| Web pure logic | `apps/web/src/lib/*.test.ts` (21 files) | `pnpm check`, CI |
| Typecheck | `tsc` everywhere; `svelte-check --fail-on-warnings`; the service worker's own `tsconfig` | `pnpm check`, CI |
| Parity pure parts | `tools/parity/src/checks.test.ts`, `fixture.test.ts` | `pnpm check`, CI |
| Smoke | `tools/smoke/src/smoke.ts` | `pnpm smoke`, CI job `smoke` |
| Parity | `tools/parity/src/parity.ts` | by hand after adapter/SDK changes |

**Smoke checks** (scratch `TENZO_HOME`, free ports, a scratch repo with one automation, a thread created without a prompt so no `claude` runs; never touches `~/.tenzo` or port 4780): start at `/`, `/new`, `/threads`; reload on New then Close; a Threads row opens its timeline and back; start at a thread's timeline and back; a long timeline holds your place; Pass motion (arrive, lift, swipe aside, come back) with and without reduced motion; Automations (next run, off switch both ways, Close) directly and from Threads; a page on another port can't frame the Pass; remote: how to pair, a pairing link lands on the Pass, revoked goes back to pairing. Each prints PASS/FAIL; any page error, second WebSocket or page load fails.

**Parity**: see [PARITY.md](PARITY.md).

**CI** (`.github/workflows/check.yml`, on pushes to `main` and on PRs, Node 24): job `check` runs `pnpm install --frozen-lockfile && pnpm check`; job `smoke` installs Playwright's Chromium headless shell (cached by version) and runs `pnpm smoke`.

## 16. Operating

### Environment variables

Read once at daemon start (`config.ts`) unless noted.

| Variable | Default | Meaning |
|---|---|---|
| `TENZO_PORT` | `4780` | Main listener port; also where the CLI finds the daemon, and Vite's proxy target. |
| `TENZO_LIVE_PORT` | `TENZO_PORT + 1` | Live listener port (must differ from `TENZO_PORT`). |
| `TENZO_LIVE_ORIGIN` | none | Public origins of the live listener, comma-separated (e.g. `https://host:8444`). Their host names are also allowed on the live listener. |
| `TENZO_HOME` | `~/.tenzo` | State directory ([§4](#4-storage)); made absolute. |
| `TENZO_WEB_DIR` | `apps/web/build` | The built web app to serve. |
| `TENZO_ALLOWED_HOSTS` | none | Host names besides loopback the daemon answers to (e.g. the Tailscale Serve name). |
| `TENZO_PUBLIC_URL` | none | Where devices reach the Pass (one origin, port included); used for pairing links. |
| `TENZO_DEV_ORIGIN` | none (`pnpm dev` sets Vite's) | Dev-server origins whose pages may use the API and `/ws`. |
| `TENZO_CLAUDE_PATH` | found | The `claude` binary threads and the titler run (read at each session start). |
| `TENZO_DEFAULT_MODEL` | Claude's own | Model for threads whose config and own choice name none. |
| `TENZO_SNOOZE_MS` | 15 min | Snooze length in ms (1,000 to 86,400,000). |
| `TENZO_PUSH_PREVIEW` | `short` | `short` or `none`. |
| `TENZO_PUSH_CONTACT` | `https://github.com/clawdude/tenzo` | VAPID contact, `mailto:` or `https:`. |
| `TENZO_LIVE_BASE` | set by Tenzo | Set *in each thread's environment* to `/live/<thread>/`, for the dev server's base path. Not read by the daemon. |
| `TENZO_SMOKE_CHROMIUM` | Playwright's cache | Chromium for `pnpm smoke`. |

### CLI (`apps/daemon/src/cli.ts`; `tenzo --help` prints the usage)

| Command | Talks to |
|---|---|
| `tenzo serve` | starts the daemon |
| `tenzo project add <path>` / `list` / `remove <name\|path>` | the database directly |
| `tenzo service install` / `uninstall` / `status` | launchd (macOS) |
| `tenzo thread start <project> [--model m] <prompt…>`, `send <id> <prompt…>`, `new <project> <title…>`, `log <id> [--follow]`, `list [<project>] [--all]`, `archive <id> [--force]` | the daemon |
| `tenzo items`, `tenzo answer <item> <choice\|text…>` | the daemon |
| `tenzo automation list [<project>]`, `run <project> <name>`, `pause`, `resume`, `archive <project> <name>` | the daemon |
| `tenzo pair [--name n] [--url origin]`, `tenzo pair --tailscale [--yes] [--https-port p] [--live-https-port p]` | the daemon (+ `tailscale`) |
| `tenzo devices`, `devices rename <id> <name…>`, `devices revoke <id>` | the daemon |
| `tenzo --version` | |

`start`, `send` and `answer` follow the thread's events until it needs you or goes idle (`--detach` to return at once, `--json` for JSON lines). Arguments after a bare `--` are positional (`args.ts`). Output formatting is in `format.ts`.

### Running the daemon

- **By hand**: `pnpm build && pnpm tenzo serve`, typically inside a `tmux` session so it survives the terminal. A second daemon on the same `TENZO_HOME` refuses to start.
- **As a service (macOS)**: `tenzo service install` writes `~/Library/LaunchAgents/dev.tenzo.daemon.plist` (0600) running `tenzo serve` from this checkout with the installing Node and the shell's environment minus terminal-session and parent-Claude variables (`service.ts` `serviceEnv`); `KeepAlive` restarts it after a crash, throttled to every 10 s; output to `$TENZO_HOME/daemon.log`. It warns when installed from a linked worktree or from inside Claude Code. Reinstall after changing settings, moving the checkout or upgrading Node.
- **Trying things safely**: a scratch `TENZO_HOME` and `TENZO_PORT` (README, "Projects and threads").

### Redeploying after a merge

1. `git pull` in the checkout the daemon runs from, then `pnpm install` if the lockfile changed.
2. `pnpm build` (the daemon serves `apps/web/build`; the daemon's TypeScript runs from source).
3. Restart the daemon: `tenzo service install` again for the service (reloads it), or stop and start `tenzo serve`. Running turns are resumed with `RESTART_PROMPT`; open questions stay on the Pass as detached items.
4. Migrations run on start. A database newer than the code refuses to open: update rather than roll back.
5. Prompt edits (`apps/daemon/prompts/*.md`) and project config edits need no restart: they apply at the next session or turn.
