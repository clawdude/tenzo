# Roadmap

Progress lives here and in [GitHub issues](https://github.com/clawdude/tenzo/issues), one issue per vertical slice, grouped by milestone. A slice is done when it is demoable end to end, not when a layer exists. Boxes get ticked in the commit that lands the slice.

## M0 · Scaffold

- [ ] #1 pnpm monorepo: `apps/daemon`, `apps/web`, `packages/contracts`, `packages/client-runtime`; typecheck + tests run with one command
- [ ] #2 Daemon starts, serves a health endpoint and a WebSocket; web shell loads and connects

## M1 · Tracer bullet: one thread, one question, one answer

The first time Tenzo is Tenzo. A Claude Code thread runs in its own worktree, asks a question, the Pass shows it on the phone, you answer, the agent continues.

- [ ] #3 `tenzo project add <path>`: projects in SQLite; worktree created per thread under `~/.tenzo/worktrees`, removed on archive
- [ ] #4 Claude adapter over the Agent SDK, running the user's own `claude` with `settingSources: user, project, local`; events normalized into Tenzo's vocabulary
- [ ] #5 Feature-parity check: a thread uses a subagent, a skill, a hook and an MCP server from the user's config, and all four work
- [ ] #6 Event store + items: SQLite tables for threads, events, items; quick-lane items derived from questions and permission requests; answers round-trip to the SDK
- [ ] #7 WebSocket API: snapshot on connect, live events after; `packages/client-runtime` owns the connection and reconnect
- [ ] #8 The Pass, first card: the pile, a question card with one suggested answer, free text with mic, folded options; answering lifts the card
- [ ] #9 New thread from the web (text in, thread starts) and a minimal Threads list

## M2 · The whole card set

- [ ] Injected MCP server: `propose`, `report`, `attach`, `expose`, `wake_me`, `start_thread`
- [ ] Thread prompts: discuss ("don't change anything until we agree"), build, landing
- [ ] Proposal card (Build it / Change something) and finished card (note, check badges, screenshots, live URL)
- [ ] Review actions: Merge (agent opens PR, waits, fixes comments, merges when mergeable), Open PR (landing + wake), Needs changes
- [ ] Back of the card: why it's asking, the change, what happened so far
- [ ] Snooze (swipe, 15 min, undo), all-clear screen, quick vs. review lanes
- [ ] Threads list and New thread in the pile language

## M3 · Config and automations

- [ ] `.tenzo/config.json` + `local.json`: agent, models per phase with thinking level, permissions, landing rule; per-thread model override
- [ ] Automations: saved prompt + project + trigger (schedule, run now); last-run summary, notes file, skip-if-running, per-run budget that pauses and asks
- [ ] Automations list with "run now" (full screen is post-MVP)

## M4 · Remote

- [ ] Local vs. remote mode; one-time pairing link / QR; revocable device tokens
- [ ] Tailscale Serve setup docs and `tenzo pair --tailscale`
- [ ] Web Push for quick-lane items, per-device mute; iOS home-screen install polish

## M5 · Codex

- [ ] Codex adapter over `codex app-server`: approvals, async questions, same card set

## Post-MVP

Automations screen · watchdog (investigate, then ask; never kill) · video capture · daemon-verified checks · multi-machine client · PC layout polish · native iPhone app if needed · event triggers
