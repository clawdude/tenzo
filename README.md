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

In `pnpm dev`, Vite proxies `/ws` and `/health` to the daemon, so the page always talks to its own origin.

## Run

```bash
pnpm build          # builds the web app into apps/web/build
pnpm tenzo serve    # daemon + web app on http://127.0.0.1:4780
```

`pnpm tenzo <command>` runs `apps/daemon/src/cli.ts` on Node's type stripping, with no build step. The file is executable and is the package's `tenzo` bin, so a symlink to it on your PATH gives you a bare `tenzo`.

The daemon serves the web app, `GET /health` (version and environment id) and the WebSocket at `/ws` from one origin, on loopback only. To reach it from a phone, put Tailscale Serve in front of that one port; the page switches to `wss:` by itself under HTTPS.

| Variable | Default | |
|---|---|---|
| `TENZO_PORT` | `4780` | port to listen on |
| `TENZO_HOME` | `~/.tenzo` | Tenzo's state, private to you: `environment-id` (this machine's stable identity), `tenzo.db` (SQLite), `worktrees/` |
| `TENZO_WEB_DIR` | `apps/web/build` | the built web app to serve |
| `TENZO_CLAUDE_PATH` | found | the `claude` threads run: by default the first on `PATH`, else `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` or `/usr/local/bin` |

## Projects and threads

A project is a local git repo Tenzo knows about. Each thread gets its own worktree under `$TENZO_HOME/worktrees/<project>/<thread-id>`, on a new branch `tenzo/<slug>` cut from the project's default branch, so your main checkout is never touched. Archiving a thread removes its worktree and keeps its branch. Tenzo writes nothing into your repo; a `.tenzo/` folder there is optional.

```bash
pnpm tenzo project add ~/code/app              # any path inside the repo; detects the default branch
pnpm tenzo project list
pnpm tenzo thread new app "Fix the login bug"  # worktree on branch tenzo/fix-the-login-bug
pnpm tenzo thread list [app] [--all]
pnpm tenzo thread archive <thread-id>          # refuses if the worktree has uncommitted changes; --force discards them
                                               # (--force also lets go of a thread whose repo was moved or deleted)
pnpm tenzo project remove app                  # refuses while the project has active threads; the repo is left alone
```

The default branch is what `origin/HEAD` points at, else a local `main` or `master`, else the checked-out branch. A slug the project already used, or one whose `tenzo/<slug>` branch already exists, gets `-2`, `-3`, … `thread new` makes the worktree without starting an agent; `thread start` (below) does both.

To try it without touching your real state, use a scratch `TENZO_HOME` and a scratch repo:

```bash
export TENZO_HOME=$(mktemp -d)
git init -q -b main /tmp/scratch && git -C /tmp/scratch commit -q --allow-empty -m init
pnpm tenzo project add /tmp/scratch
pnpm tenzo thread new scratch "Try it"
git -C /tmp/scratch worktree list              # main checkout plus the thread's worktree
pnpm tenzo thread archive <thread-id>          # worktree gone, branch tenzo/try-it kept
```

## Running Claude Code in a thread

Threads run your own `claude` (see `TENZO_CLAUDE_PATH`) through the Claude Agent SDK, with your own login and everything your terminal `claude` loads: user, project and local settings, `CLAUDE.md`, subagents, skills, hooks, MCP servers and plugins, and Claude Code's own system prompt. Tenzo only sets the permission mode to accept edits and catches questions and permission prompts so they can come to you. Threads get Tenzo's environment minus the variables a parent Claude Code session exports (`CLAUDECODE`, its session id, IDE port, bridge wiring), so running Tenzo from inside Claude Code doesn't tie its threads to that session; your configuration (`CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, Bedrock/Vertex, proxies) passes through.

```bash
pnpm tenzo thread start scratch "create hello.txt containing hi"   # new thread + one turn
pnpm tenzo thread send <thread-id> "now make it say hello"         # another turn, same conversation
```

Both print the thread's events as they happen (`--json` for JSON lines), ask you on the terminal when Claude uses `AskUserQuestion` or wants permission for something accept-edits doesn't cover (`y`, `n`, or a reason to deny), and exit when the turn ends. `--model haiku` picks a model. Claude's session id is stored on the thread, so `send` resumes the conversation even after a restart. Until the daemon and the Pass take over (#6–#9), this is how a thread runs.

`pnpm parity` checks that a thread really has everything the terminal has: one real thread on haiku in a scratch project with a subagent, a skill, a hook and an MCP server, then a PASS/FAIL table. Re-run it after every adapter change; see [docs/PARITY.md](docs/PARITY.md).

The events are Tenzo's own vocabulary (`packages/contracts/src/runtime.ts`): `session.*`, `turn.*`, `item.*`, `request.opened/resolved`, `user-input.requested/resolved`, `runtime.error`. Nothing above the agent adapter (`apps/daemon/src/agent/`) knows it is talking to Claude.
