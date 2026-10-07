# Feature-parity check

Tenzo must never reduce what Claude Code can do ([PRODUCT.md §2.6](../../docs/PRODUCT.md#2-opinions)). This check proves it for the four things people configure most: a **subagent**, a **skill**, a **hook** and an **MCP server**, each defined in a project's `.claude/` folder the way a user would. One real thread runs in a scratch daemon, driven through the real `tenzo` CLI, and has to use all four. It also checks that Tenzo's own MCP server, `tenzo`, sits beside the user's servers instead of replacing them.

Re-run it after every change to the Claude adapter (`apps/daemon/src/agent/`), the thread runner, or the Agent SDK version.

```bash
pnpm parity                  # haiku, one thread, ~10 s, ~$0.04
pnpm parity --model sonnet   # any model `tenzo thread start --model` takes
pnpm parity --keep           # keep the scratch directory even on a pass
```

It needs your `claude` signed in (found as `tenzo` finds it; `TENZO_CLAUDE_PATH` to override) and uses your subscription. It is not part of `pnpm check` or CI; its pure parts are (`src/*.test.ts`).

What it does:

1. Copies `fixture/` to a fresh temp directory, renames its inert `dot-claude/` and `dot-mcp.json` to `.claude/` and `.mcp.json`, and makes it a git repo.
2. Points `TENZO_HOME` at that directory and `TENZO_PORT` at a free port, so `~/.tenzo` and a running daemon are never touched. Adds the project, starts a scratch `tenzo serve`, and starts the thread: `tenzo thread start <copy> --model haiku --detach -- <prompt>`.
3. Follows the thread's events and answers its items with `tenzo answer`: `allow` for the fixture's MCP tool, a denial with a reason for anything else. A question ends the run (the Turn check then fails).
4. Stops at the end of the first turn, stops the daemon (always), checks the events and the hook's log in the worktree, prints the table, and exits 0 on a pass. On a pass the temp directory is deleted; on a failure it's kept with `events.jsonl` and `tenzo.stderr`.

```
Check           Result  Detail
Subagent        PASS    Agent → parity-agent (background) said lantern-42 in the thread
Skill           PASS    listed, invoked by name, reply has compass-17
Hook            PASS    PostToolUse ran 4× (Skill, Agent, ToolSearch, mcp__parity__ping), wrote .parity/hooks.jsonl
MCP server      PASS    parity connected, mcp__parity__ping returned pong:b80fee2b:tenzo-parity-mcp
Tenzo's server  PASS    tenzo connected beside parity, 4 tools listed
Turn            PASS    completed on claude-haiku-4-5-20251001, allowed mcp__parity__ping when asked (1×), $0.0715, 12.8s

PASS: the thread had everything the terminal has.
```

When Claude runs the subagent in the foreground, the Subagent row reads `Agent → parity-agent returned lantern-42`, which is just as valid.

## The fixture

`fixture/` is ordinary project-level configuration, stored as `dot-claude/` and `dot-mcp.json` so Claude Code sessions working on Tenzo itself don't discover it:

| File | Defines |
|---|---|
| `.claude/agents/parity-agent.md` | a subagent (haiku, Read only) that answers `AGENT_CODEWORD=lantern-42` |
| `.claude/skills/parity-skill/SKILL.md` | a skill whose content holds `SKILL_CODEWORD=compass-17` |
| `.claude/settings.json` | a `PostToolUse` hook on every tool (`.claude/hooks/record-tool.mjs`, appends `{hook, tool}` to `.parity/hooks.jsonl`), and `enabledMcpjsonServers: ["parity"]` |
| `.mcp.json` | a stdio MCP server, `parity`, in plain Node (`.claude/mcp/parity-server.mjs`); its tool `ping` answers `pong:<word>:tenzo-parity-mcp` |

The prompt (`parityPrompt` in `src/checks.ts`) asks for the four steps by name and gives the MCP tool a fresh word each run. It never mentions the codewords, so they can only come through the feature under test, not through Claude reading the files: the main thread may use only `Skill`, `Agent`, `ToolSearch` (which loads deferred MCP tools) and `mcp__parity__ping`, none of them pointed at `.claude/`. (Read never asks permission, so without this rule a broken Skill tool plus a Read of `SKILL.md` would pass.) A subagent may use its own tools.

## What each check proves

| Check | Passes when | Proves |
|---|---|---|
| Subagent | `session.configured` lists `parity-agent`; an `Agent` item ran it and completed; `lantern-42` is in its result (foreground) or the subagent's own message under it (background), not in the call's input; the main thread didn't peek | project subagents load, run, and their output reaches the thread |
| Skill | `session.configured` lists `parity-skill`; a `Skill` item invoked it by name and completed; `compass-17` is in Claude's reply; no peeking | project skills are listed, invokable, and reach the model |
| Hook | `.parity/hooks.jsonl` in the worktree has a `PostToolUse` entry for `mcp__parity__ping` | project hooks run in the worktree, for MCP tools too |
| MCP server | `parity` is `connected`; `mcp__parity__ping` completed with this run's pong | project MCP servers start and work, through Tenzo's permission prompt |
| Tenzo's server | `tenzo` and `parity` both `connected` in the same session, with `tenzo`'s tools listed | Tenzo's server is added beside the user's, never in place of them |
| Turn | the turn completed with no runtime error, no prompt but the MCP tool's permission, and no main-thread tool outside the four steps | nothing failed around the four |

The checks are pure functions over the events (`src/checks.ts`, tested in `checks.test.ts`). `fixture.test.ts` copies the fixture as the run does and runs its MCP server and hook directly.

## Caveats

- **Workspace trust.** Claude Code ignores a project's `permissions.allow` until the workspace is trusted, and a fresh temp copy never is, so the MCP tool asks permission in the terminal and in Tenzo alike. That's why the fixture has no allow rules and the script answers the prompt, which also exercises Tenzo's permission round-trip. Trust is keyed by the main repo's path, so a repo you trusted in the terminal stays trusted in Tenzo's worktrees.
- **MCP approval.** Without a person to ask, the SDK starts `.mcp.json` servers without approval; `enabledMcpjsonServers` makes an interactive `claude` in the copy behave the same, for comparison.
- **Background subagents.** Claude Code 2.1 runs `Agent` calls in the background by default ("Async agent launched"; the answer arrives as the subagent's own messages). The check accepts both. The daemon keeps a session up after its turn, so background work keeps reporting; the check reads only up to the end of the first turn.
- **Your config loads too**: your user settings, plugins, skills and MCP connectors, as for a real thread. A user-level hook or permission rule can change the outcome; the table says which check it broke.
- **Discussing.** A new thread starts in discuss with your own `defaultMode`. The parity prompt changes nothing, so the discuss prompt's "just do it, no proposal" applies; a `propose` or `report` call would fail the Turn check.
- **The model can wander.** A single failure where Claude didn't do what it was asked is the model, not Tenzo: re-run, or try `--model sonnet`. The same failure twice is a finding.
