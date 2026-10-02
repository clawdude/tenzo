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
| `TENZO_HOME` | `~/.tenzo` | Tenzo's state; holds `environment-id`, this machine's stable identity |
| `TENZO_WEB_DIR` | `apps/web/build` | the built web app to serve |
