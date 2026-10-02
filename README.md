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
