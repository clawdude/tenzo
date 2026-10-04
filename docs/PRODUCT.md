# Tenzo: product and decisions

Written 2026-10-02 from the first design session. Everything here is decided unless it sits under *Open* or *Parked*.

## 1. What Tenzo is

An **attention queue for coding agents**.

Agents (Claude Code, later Codex) run as long-lived **threads** on your machine, each in its own git worktree. Tenzo watches them and presents you with **one item at a time** when a thread needs you. You handle it, it goes away, the next one appears. You never see five chats blinking at once.

It works from your phone and from any browser on another computer, and controls the machine where the agents run.

Reference: [T3 Code](https://github.com/pingdotgg/t3code), cloned at `../reference/t3code` and mapped file by file in [REFERENCE.md](REFERENCE.md). Tenzo borrows its *shape* (a daemon on the agent machine owns everything; thin clients; Claude via the Agent SDK, Codex via `codex app-server`; your CLI logins are the subscriptions; Tailscale Serve for remote) and rejects its *scale* (no IDE features: no terminal, diff viewer, device panels, cloud relay).

## 2. Opinions

Tenzo is small, but it is not neutral. These are the opinions it enforces, and the reason each exists.

1. **The agent talks before it codes.** A new thread starts as a conversation. The agent reads the repo, asks only when something ambiguous would change the outcome (one question at a time), and when it knows what to do it says so and stops. You tap *Build it*. Nothing edits your code before you've seen what's about to happen. *(Why: the expensive mistakes are made in the first five minutes.)*
2. **One thing at a time.** The main screen shows one item. There is no inbox view competing with it. *(Why: this is the whole product.)*
3. **Briefs, not transcripts.** An item is two lines of context, the ask, a suggested answer, and buttons. The full transcript is one tap away and never in your face. *(Why: you're deciding, not reading.)*
4. **Nothing lands without you.** Finished work comes back as a review item with a handoff note, screenshots, a live URL, and check results. You choose *Merge*, *Open PR*, or *Needs changes*. *(Why: speed without silent merges.)*
5. **The agent does the follow-up itself.** It opens the PR, waits for CI and reviewers (humans and bots like Greptile alike), fixes review comments on its own, and only comes to you when it disagrees. It never approves its own PR. *(Why: you said you don't want to review every PR.)*
6. **Your tools, untouched.** Threads run the real `claude` binary with your config: subagents, skills, hooks, MCP servers, plugins all load exactly as in the terminal. Tenzo is a client, not a reimplementation. Anything that works in the terminal works here. *(Why: feature parity is non-negotiable.)*
7. **A worktree per thread, always.** Threads never touch your main checkout. *(Why: five agents on one checkout trample each other.)*
8. **Tenzo knows nothing about your tracker.** No tickets, specs, GitHub, Linear, or skills inside Tenzo. Work items live wherever you already track them; the agent reads and updates them through prompts and `gh`. Ideas from Matt Pocock's skills (interview first, briefs, push the checkpoint late) are built into Tenzo's prompts, never imported as dependencies. *(Why: configurable and light, and so deleting Tenzo loses nothing.)*
9. **Focus on the problem; everything else is transparent.** Settings live in a config file and a small "⋯"; the main screen never shows them. *(Why: the app should get out of your way.)*

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Project** | A local git repo the daemon knows about. |
| **Thread** | One agent session on one project, in its own worktree and branch. Has an *origin* (you typed it, an automation fired, …). |
| **Item** | Something a thread needs from you: a question, a permission request, a proposal, finished work, an error, a ready-to-merge PR. |
| **The Pass** | The main screen: the current item, with the rest of the pile visible behind it. |
| **Quick lane / review lane** | Items where the agent is *stuck waiting* (question, permission, proposal, error, ready to merge) vs. finished work waiting for review. Quick lane first; only the quick lane pushes to your phone. |
| **Landing** | A thread whose work is pushed and waiting on the outside world (CI, reviewers) before it can merge. Still visible; can't be forgotten. |
| **Snooze** | Swipe an item away for 15 minutes. It comes back. |
| **Automation** | A saved prompt + project + trigger (schedule or "run now") that starts a thread by itself. |

## 4. The thread flow

```
you type what you want
   → agent reads the repo
   → asks only if needed (one question at a time; options as buttons, one suggested)
   → "I'm going to do X" (proposal item; Build it / Change something)
   → builds
   → review item: handoff note, screenshots, live URL, check badges
       Merge         → agent pushes, opens PR, waits for CI + required approvals + bot reviews,
                       fixes comments itself, merges when mergeable, archives thread
       Open PR       → thread goes to "landing", wakes itself to check, pokes you when mergeable
       Needs changes → your note goes back into the thread
```

Follow-up messages during build or review execute directly; no second proposal step. A genuinely new piece of work is a new thread.

Mechanism: no Claude plan mode and no visible modes. The thread prompt says "don't change anything until we agree," and Tenzo's injected MCP server gives the agent `propose(summary)` to pause for approval. Same for Codex. The prompts are plain files in `apps/daemon/prompts/`, appended to Claude Code's own system prompt. Tenzo never sets the permission mode, in any phase: your own `defaultMode` (user, project or local settings) applies, as in your terminal; discussing is held by the prompt and `propose`, not by a mode. A system prompt is fixed for a session's life, so *Build it* reaches a running session as `propose`'s result (the approval plus the build prompt); every later session of the thread starts with the build prompt.

**Thread lifecycle:** `discussing → building → review → landing → archived`. Only archived threads leave the list. The agent can ask the daemon to **wake it later** (`wake_me(in, why)`) while landing or waiting on anything.

Landing works the same way: *Merge* and *Open PR* reach the agent as a message carrying the landing prompt (`landing.md`), and *Needs changes* as your note (back to building). The agent says what happened through two more tools: `ready_to_merge(url)` after *Open PR* puts a quick-lane card with *Merge* on the Pass, and `landed(url)` after it merged makes the daemon archive the thread once the turn ends. The finished card keeps *Done* (nothing to land) as a quiet option next to *Open PR*.

## 5. The Pass (UI)

Chosen after four rounds of mock-ups (see `docs/mockups`):

- **A pile of cards.** The current item is a card; the ones behind it stick out above, darker and narrower, up to four edges. The pile's height is the only status display. No title, no counts.
- **On the card:** thread name (small caps), one or two lines of context (large), the question or headline, a visible *More* pill ("Why it's asking" / "See the change" / "What it looked at"). At the bottom, under your thumb: **one filled button** that is always the suggested action, a **free-text field with a mic**, and the other options folded behind "2 other options."
- **Text scrolls inside the card; buttons don't.** Long context never pushes the answer off screen.
- **Answer → card lifts away, the next one is already there.**
- **Swipe → snooze 15 min**, toast with Undo.
- **Back of the card:** for a question, *why it's asking* (the agent's reasoning, each option weighed, files it will touch). For finished work, *the change* (files with +/−, how to try it, what's not done, screenshots). One tap deeper: *what happened so far* (timeline with expandable outputs, full transcript).
- **All clear:** the "What do you want to do?" card becomes the main thing; working and snoozed threads listed quietly under *Meanwhile*.
- **New** is a small + top right. Threads list is one tap top right.
- **Look:** black ground, one card tone, system font, no borders, depth by layering, one accent (clay `#D97757`) only for "needs you" and the primary action; blue working, green done. Subtle motion that explains what happened; nothing decorative.
- **Dictation:** iOS keyboard mic first; a mic button using browser speech recognition soon after.

Not yet designed in this language: Threads list, New thread, the PC layout, Automations.

## 6. Verification without reading code

Every finished item carries, via Tenzo's injected MCP server:

- `report(summary, how_to_test, checks)`: the handoff note and agent-reported check results (tests, typecheck, lint) shown as badges.
- `attach(file)`: screenshots the agent took (Playwright/Chromium are on the machine).
- `expose(port)`: a live URL to the dev server in that thread's worktree, reachable from your phone over the tailnet.

`report` doesn't wait for you: it puts the card on the Pass, the thread enters review, and the agent ends its turn; your answer reaches it as a message. `attach` takes images from the thread's worktree only. `expose` makes the dev server reachable at `/live/<thread>/` on Tenzo's **live origin**, a second listener of its own, and only that thread's port; the server must serve under that base. Never on Tenzo's own origin: a live page could otherwise drive Tenzo (answer your cards, start threads). Over the tailnet that takes a second Tailscale Serve route.

Later: video, and daemon-verified checks (the daemon runs the project's check commands itself).

## 7. Automations

An automation is a saved thread recipe:

```
name:     review open PRs
project:  tenzo
trigger:  every hour  |  run now
prompt:   "List open PRs with gh. For each one you haven't reviewed, run /code-review
           and post findings as a PR comment."
budget:   max wall clock / cost per run
```

When it fires, the daemon starts an ordinary thread with that prompt and origin `automation`. The agent talks to GitHub (or anything) itself; Tenzo has no integrations. Items from automation threads land on the same Pass. Automations can spawn more threads via `start_thread`.

Memory between runs: the daemon passes the previous run's summary into the prompt; each automation has a notes file (`.tenzo/automations/<name>.md`) the agent may update; the prompt tells the agent to leave markers in the external system. Skip a run if the previous one is still going. Budget trips pause and ask; they never kill.

MVP triggers: schedule and "run now." Event triggers (webhooks) later; they need the daemon reachable from the internet.

## 8. Projects, config, worktrees

- Adding a project = pointing the daemon at a local repo. Tenzo clones nothing.
- Worktrees: `~/.tenzo/worktrees/<project>/<thread-id>`, branch `tenzo/<slug>` from the default branch. Removed when the thread archives; branch kept.
- `.tenzo/config.json` (committed) + `.tenzo/local.json` (gitignored, personal overrides such as which Claude account):

```json
{
  "agent": "claude",
  "models": {
    "discuss": { "model": "opus",   "thinking": "high" },
    "build":   { "model": "sonnet", "thinking": "medium" },
    "agents":  { "model": "haiku" }
  },
  "landing": "pr"
}
```

Anything missing falls back to the agent's own defaults. A `permissions` key (M3) is an optional override of the permission mode; absent, your own `defaultMode` applies in every phase. Discuss model runs until *Build it*; build model after; agents model is passed to subagents. A thread can override model from its "⋯".

## 9. Remote access and auth

- **Local mode:** daemon on `127.0.0.1`, no login.
- **Remote mode:** daemon on the LAN or tailnet address. First contact is a **one-time pairing link / QR** shown on the host; the device exchanges it for its own revocable token. Tailscale (or your own tunnel) is the pipe, not the identity.
- **No cloud of ours.** No accounts, no relay. Push notifications use Web Push: the daemon only needs *outbound* access to Apple's push service, so a tailnet-only daemon can still poke your phone.
- Push only for quick-lane items; per-device mute.

## 10. Stack

- **Daemon:** Node 22+, TypeScript, `node:sqlite`, Hono + `ws`, zod contracts. Claude via `@anthropic-ai/claude-agent-sdk` wrapping your `claude` binary with `settingSources: user, project, local`; Codex via `codex app-server` JSON-RPC.
- **Web UI:** Svelte 5, SvelteKit (static adapter), Tailwind v4, shadcn-svelte. Installed to the iPhone home screen; a browser tab on the PC.
- **Repo:** pnpm monorepo: `apps/daemon`, `apps/web`, `packages/contracts`, `packages/client-runtime` (framework-free, so native or desktop shells are additive later).
- **Not:** Effect, Electron, Bun, Rust, React Native (for now).
- **Storage:** Tenzo keeps only its own state in SQLite (threads, items, automations, device tokens, an event cache for the UI). Transcripts stay Claude's; threads resume by session ID.
- Environment ID on every record from day one; the client talks to one daemon for now, several later.

## 11. MVP scope

In:
1. Daemon spawning Claude Code threads in worktrees; normalized events; SQLite.
2. The Pass as designed (pile, card, suggested + free text, More, snooze, all clear). Threads list and New thread in the same language.
3. Thread flow: discuss → propose → build → review → merge/PR/changes, with the injected MCP tools (`propose`, `report`, `attach`, `expose`, `wake_me`, `ready_to_merge`, `landed`, `start_thread`).
4. `.tenzo/config.json` with agent, models per phase, permissions, landing rule.
5. Automations with schedule + run now (no UI beyond a list and "run now" at first).
6. Local mode + remote mode with pairing; Web Push.
7. Codex adapter immediately after the Pass works end to end.

Out (for now): Automations screen, video capture, daemon-verified checks, multi-machine client, native apps, desktop shell, watchdog, event triggers, multiple accounts UI.

## 12. Open

- Tuning the thread prompts (`apps/daemon/prompts/`: discuss, build and landing), including how sparingly the agent asks.
- Threads list, New thread, and PC layout in the pile language.
- Automations screen (post-MVP).
- License (MIT suggested).

## 13. Parked, on purpose

- **Watchdog.** Never auto-kill. When something looks wrong (no progress, budget blown), investigate first, then put a question on the Pass. Design it after the MVP has run for a while.
- **Native iPhone app** (Live Activities, haptics) if home-screen web turns out not to be enough.
