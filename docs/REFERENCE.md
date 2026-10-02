# Reference: T3 Code

Tenzo takes its architecture from [T3 Code](https://github.com/pingdotgg/t3code) (MIT). When working on Tenzo, read the corresponding T3 code before designing something from scratch; it has already solved most of the daemon-side problems. Copy the shape, not the scale: T3 is an IDE, Tenzo is a card.

## Where it is

A clone lives **next to this repo**, outside it:

```
../reference/t3code        # i.e. ~/coding/reference/t3code on the Mac mini
```

If it's missing:

```bash
git clone --depth 1 https://github.com/pingdotgg/t3code.git ../reference/t3code
```

Update with `git -C ../reference/t3code pull`.

## Start with the docs

- `docs/internals/overview.md` — ownership boundaries, event log as source of truth, reactors vs. decider.
- `docs/internals/providers.md` — the adapter boundary and protocol traps (Codex async questions, capabilities).
- `docs/internals/remote.md` + `docs/user/remote-access.md` — routes (direct, Tailscale Serve, SSH, relay) vs. auth.
- `docs/internals/environment-auth.md` — pairing links, scoped sessions, WebSocket tickets.
- `docs/internals/connection-runtime.md` — one reconnect owner per environment, cache vs. liveness.
- `docs/user/providers-claude.md`, `docs/user/providers-codex.md` — multiple accounts via `CLAUDE_CONFIG_DIR` / `CODEX_HOME`.

## Code map (paths under the clone)

| Tenzo concern | T3 Code |
|---|---|
| Claude adapter (Agent SDK, `canUseTool`, `AskUserQuestion`, `ExitPlanMode` as "plan ready") | `apps/server/src/provider/Layers/ClaudeAdapter.ts` |
| Claude config dir / keychain handling | `apps/server/src/provider/Drivers/ClaudeHome.ts` |
| Codex adapter (`codex app-server`, approvals, `requestUserInput`) | `apps/server/src/provider/Layers/CodexAdapter.ts`, `CodexSessionRuntime.ts`, `packages/effect-codex-app-server/` |
| The adapter interface | `apps/server/src/provider/Services/ProviderAdapter.ts` |
| Normalized event vocabulary | `packages/contracts/src/providerRuntime.ts` |
| Folding events into state | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `orchestration/decider.ts`, `projector.ts` |
| SQLite layout (event store + projections) | `apps/server/src/persistence/` |
| Injected MCP server (`t3-code`) | search `t3-code` in `ClaudeAdapter.ts` and `apps/server/src/provider/Layers/ProviderService.ts` |
| Idle session reaper, interrupt timeouts | `apps/server/src/provider/ProviderSessionReaper.ts` |
| Usage-limit handling | `apps/server/src/provider/Layers/claudeUsageLimits.ts`, `codexUsageLimits.ts` |
| Pairing, sessions, scopes | `apps/server/src/auth/` (`http.ts`, `RpcAuthorization.ts`, `PairingGrantStore.ts`), `apps/server/src/startupAccess.ts` |
| Tailscale Serve | `packages/tailscale/src/tailscale.ts`, `apps/server/src/cli/pair.ts` |
| Client connection runtime (reconnect, cache) | `packages/client-runtime/src/connection/`, `rpc/`, `state/threads.ts` |
| "Needs attention" priority and inbox ordering | `apps/web/src/components/Sidebar.logic.ts` (`resolveThreadStatusPill`), `Sidebar.tsx` (shelves, snooze) |
| Notifications, badge, sounds | `apps/web/src/components/ThreadNotificationCoordinator.tsx` |
| Streaming timeline performance | `apps/web/src/components/chat/MessagesTimeline.tsx`, `markdown-incremental.ts` |
| Checkpoints via hidden git refs | `apps/server/src/checkpointing/CheckpointStore.ts` |

## What Tenzo deliberately does not take

Effect (everywhere in T3), the cloud relay (`infra/relay`), SSH-launched servers, terminals, diff viewer, device panel, theme engine, Electron, the Expo app. See `docs/PRODUCT.md` §1 and §10.
