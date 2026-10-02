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

The default branch is what `origin/HEAD` points at, else a local `main` or `master`, else the checked-out branch. A slug the project already used, or one whose `tenzo/<slug>` branch already exists, gets `-2`, `-3`, … `thread new` is a stand-in until threads start agents (#4, #6, #9).

To try it without touching your real state, use a scratch `TENZO_HOME` and a scratch repo:

```bash
export TENZO_HOME=$(mktemp -d)
git init -q -b main /tmp/scratch && git -C /tmp/scratch commit -q --allow-empty -m init
pnpm tenzo project add /tmp/scratch
pnpm tenzo thread new scratch "Try it"
git -C /tmp/scratch worktree list              # main checkout plus the thread's worktree
pnpm tenzo thread archive <thread-id>          # worktree gone, branch tenzo/try-it kept
```
| `TENZO_WEB_DIR` | `apps/web/build` | the built web app to serve |
