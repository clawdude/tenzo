# Contributing

Read [docs/PRODUCT.md](docs/PRODUCT.md) first: what Tenzo is, the opinions it enforces, the MVP scope. Its decisions are settled; reopen one only when the maintainer asks. Then [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the parts, the core flows and the architectural decisions, as of `main`. Work from these docs, not from memory: they describe `main`.

## Principles

- Tenzo must never reduce what Claude Code (or later Codex) can do. Threads run the real binaries with the user's own config: subagents, skills, hooks, MCP, plugins.
- Tenzo knows nothing about issue trackers, specs or skills. Those belong to the agent and its prompts.
- Keep it light: a feature that can be a prompt should be a prompt.
- Design questions go one at a time, each with a recommended answer.

## How work is done

1. [docs/ROADMAP.md](docs/ROADMAP.md) is the plan; GitHub issues are the tasks. Take the lowest-numbered open issue whose blockers are closed, and read its latest comment first: it holds the handoff state.
2. One branch and one PR per slice; nothing is pushed to `main` directly. A builder opens the PR, a separate reviewer reviews it, and it lands by squash merge.
3. A slice is done when its acceptance criteria are demonstrably met, `pnpm check` is green, its box in the roadmap is ticked, the docs match the change, and the PR says `Closes #N`.
4. **The docs always describe `main`.** A change to the architecture or to a decision updates `docs/ARCHITECTURE.md` in the same PR (a new decision gets an entry); env vars, CLI, config keys and how-tos update `docs/GUIDE.md` or `docs/REMOTE.md`; the README stays a short introduction. Reviewers check it; a PR that skips it is not done. When code and docs disagree, the code wins and the docs get fixed.
5. Never force-push. To catch up with `main`, merge `origin/main` into the branch.
6. Build, test, commit, push and open PRs without asking (`.claude/settings.json` allows them); ask before anything destructive.

## Develop

Node 22.18+ and pnpm 10.

```bash
pnpm install
pnpm dev      # daemon on 127.0.0.1:4780 (TENZO_PORT to change), web on localhost:5173
pnpm check    # typecheck + tests in every package; CI runs the same
pnpm smoke    # the built web app in headless Chromium against a scratch daemon
pnpm parity   # one real Claude thread proves the user's config still works
```

In `pnpm dev`, Vite proxies `/ws` and `/health` to the daemon, so the page talks to its own origin; the daemon's dev script sets `TENZO_DEV_ORIGIN` to Vite's origins, the only others it accepts pages from.

**`pnpm smoke`** drives the app in iPhone emulation, for what unit tests can't see: each screen loaded directly, navigation and Close, a thread's timeline, the Pass's motion (with and without reduced motion), Automations, framing protection, pairing from elsewhere. Any page error, a second WebSocket or page load fails it; the checks are listed in `tools/smoke/src/smoke.ts`. It needs no `claude` and leaves `~/.tenzo` and port 4780 alone. It uses `TENZO_SMOKE_CHROMIUM`, else Playwright's Chromium (`pnpm --filter @tenzo/smoke exec playwright-core install --only-shell chromium`). CI runs it beside `pnpm check`; run it locally after changing routes or navigation.

**`pnpm parity`** runs after every change to the agent adapter, the thread runner or the Agent SDK version; see [tools/parity/README.md](tools/parity/README.md). It uses your `claude` login and is not part of CI.

## Stack

pnpm monorepo ([PRODUCT.md §10](docs/PRODUCT.md#10-stack)):

- `apps/daemon`: Node 22+, TypeScript run from source, `node:sqlite`, Hono + `ws`
- `apps/web`: Svelte 5, SvelteKit static, Tailwind v4
- `packages/contracts`: zod schemas for every wire and storage shape
- `packages/client-runtime`: the framework-free client (connection, store)
- `tools/smoke`, `tools/parity`: the two end-to-end checks

## Reference: T3 Code

Tenzo takes its architecture from [T3 Code](https://github.com/pingdotgg/t3code) (MIT), which has already solved most daemon-side problems. Read its code for a concern before designing it from scratch, then build the smaller version: copy the shape, not the scale. T3 is an IDE; Tenzo is a card. Don't take Effect, the cloud relay, SSH-launched servers, terminals, the diff viewer, device panels, the theme engine, Electron or the Expo app.

A clone lives next to this repo, outside it:

```bash
git clone --depth 1 https://github.com/pingdotgg/t3code.git ../reference/t3code   # update: git -C ../reference/t3code pull
```

Start with its `docs/internals/` (`overview.md`: ownership, the event log, reactors vs. decider; `providers.md`: the adapter boundary and protocol traps; `remote.md`, `environment-auth.md`, `connection-runtime.md`) and `docs/user/` (`remote-access.md`; `providers-claude.md` and `providers-codex.md` for multiple accounts via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`). Then:

| Tenzo concern | T3 Code |
|---|---|
| Claude adapter (Agent SDK, `canUseTool`, `AskUserQuestion`, `ExitPlanMode`) | `provider/Layers/ClaudeAdapter.ts`; config dir and keychain: `provider/Drivers/ClaudeHome.ts` |
| Codex adapter (`codex app-server`, approvals, `requestUserInput`) | `provider/Layers/CodexAdapter.ts`, `CodexSessionRuntime.ts`, `packages/effect-codex-app-server/` |
| The adapter interface | `provider/Services/ProviderAdapter.ts` |
| Normalized event vocabulary | `packages/contracts/src/providerRuntime.ts` |
| Folding events into state | `orchestration/Layers/ProviderRuntimeIngestion.ts`, `orchestration/decider.ts`, `orchestration/projector.ts` |
| SQLite layout | `persistence/` |
| Injected MCP server | search `t3-code` in `ClaudeAdapter.ts` and `provider/Layers/ProviderService.ts` |
| Idle reaper, interrupt timeouts | `provider/ProviderSessionReaper.ts` |
| Usage limits | `provider/Layers/claudeUsageLimits.ts`, `codexUsageLimits.ts` |
| Pairing, sessions, scopes | `auth/` (`http.ts`, `RpcAuthorization.ts`, `PairingGrantStore.ts`), `startupAccess.ts` |
| Tailscale Serve | `packages/tailscale/src/tailscale.ts`, `apps/server/src/cli/pair.ts` |
| Client connection runtime | `packages/client-runtime/src/connection/`, `rpc/`, `state/threads.ts` |
| "Needs attention" ordering | `apps/web/src/components/Sidebar.logic.ts` (`resolveThreadStatusPill`), `Sidebar.tsx` |
| Notifications, badge, sounds | `apps/web/src/components/ThreadNotificationCoordinator.tsx` |
| Streaming timeline | `apps/web/src/components/chat/MessagesTimeline.tsx`, `markdown-incremental.ts` |
| Checkpoints via hidden git refs | `checkpointing/CheckpointStore.ts` |

Paths not starting with `apps/` or `packages/` are under `apps/server/src/`.
