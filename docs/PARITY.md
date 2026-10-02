# Feature-parity check

Tenzo must never reduce what Claude Code can do (PRODUCT.md). This check proves it for the four things people configure most: a **subagent**, a **skill**, a **hook** and an **MCP server**, each defined in a project's `.claude/` folder the way a user would. One real thread runs through the real `tenzo` CLI and has to use all four.

Re-run it after every change to the Claude adapter (`apps/daemon/src/agent/`), the thread runner, or the Agent SDK version.

## Run it

```bash
pnpm install
pnpm parity                  # haiku, one thread, ~10 s, ~$0.04
pnpm parity --model sonnet   # any model name `tenzo thread start --model` takes
pnpm parity --keep           # keep the scratch directory even on a pass
```

It needs your `claude` signed in (found as `tenzo` finds it; `TENZO_CLAUDE_PATH` to override) and uses your subscription. It is not part of `pnpm check` or CI; the pure parts are (`tools/parity/src/*.test.ts`).

What it does:

1. Copies `tools/parity/fixture` to a fresh temp directory, renames its inert `dot-claude/` and `dot-mcp.json` to `.claude/` and `.mcp.json`, then `git init`s and commits it.
2. Points `TENZO_HOME` at the same temp directory, so `~/.tenzo` is never touched, and runs
   `tenzo project add <copy>` and `tenzo thread start <copy> --model haiku --json -- <prompt>`.
3. Watches the events as they stream and answers tenzo's prompts on stdin the way you would: `y` to the fixture's MCP tool, a denial to anything else, end of input to a question.
4. Reads the events and the hook's log in the thread's worktree, prints the table, and exits 0 on a pass. On a pass the temp directory is deleted; on a failure it's kept with `events.jsonl` (every event) and `tenzo.stderr`.

```
Check       Result  Detail
Subagent    PASS    Agent → parity-agent (background) said lantern-42 in the thread
Skill       PASS    listed, invoked by name, reply has compass-17
Hook        PASS    PostToolUse ran 4× (Skill, Agent, ToolSearch, mcp__parity__ping), wrote .parity/hooks.jsonl
MCP server  PASS    parity connected, mcp__parity__ping returned pong:110cb60c:tenzo-parity-mcp
Turn        PASS    completed on claude-haiku-4-5-20251001, allowed mcp__parity__ping when asked (1×), $0.0415, 10.0s

PASS: the thread had everything the terminal has.
```

Claude decides whether to run the subagent in the background or the foreground. In the foreground the Subagent row reads `Agent → parity-agent returned lantern-42` instead, which is just as valid.

## The fixture

`tools/parity/fixture` is ordinary project-level configuration, nothing Tenzo-specific. It is stored as `dot-claude/` and `dot-mcp.json` so Claude Code sessions working on Tenzo itself don't discover it (Claude Code finds `.claude/skills` in subdirectories); the copy gets the real names:

| File | Defines |
|---|---|
| `.claude/agents/parity-agent.md` | a subagent (haiku, Read only) that answers `AGENT_CODEWORD=lantern-42` |
| `.claude/skills/parity-skill/SKILL.md` | a skill whose content holds `SKILL_CODEWORD=compass-17` |
| `.claude/settings.json` | a `PostToolUse` hook on every tool, running `.claude/hooks/record-tool.mjs`, which appends `{hook, tool}` to `.parity/hooks.jsonl`; and `enabledMcpjsonServers: ["parity"]` |
| `.mcp.json` | a stdio MCP server, `parity`, in plain Node with no dependencies (`.claude/mcp/parity-server.mjs`); its one tool `ping` answers `pong:<word>:tenzo-parity-mcp` |

The prompt (`parityPrompt` in `tools/parity/src/checks.ts`) asks for the four steps by name and gives the MCP tool a word that is fresh each run. It never mentions the codewords, so they can only come from the fixture's files. They must come through the feature under test, not through Claude reading those files. So the main thread may use only `Skill`, `Agent`, `ToolSearch` (which loads deferred MCP tools) and `mcp__parity__ping`, and none of them may be pointed at `.claude/`. Read, Glob and Grep never ask permission, so without this rule a broken Skill tool plus a Read of `SKILL.md` would still pass. A subagent may use its own tools.

## What each check proves

| Check | Passes when | Proves |
|---|---|---|
| Subagent | `session.configured` lists `parity-agent`; an `Agent` tool item ran it (`subagent_type`) and completed; `lantern-42` is in its result (foreground) or in the subagent's own message under it (`parentItemId`, background), and not in the Agent call's input; the main thread didn't peek | project subagents load, run, and their output reaches the thread's events |
| Skill | `session.configured` lists `parity-skill`; a `Skill` tool item invoked it by name and completed; `compass-17` appears in Claude's reply; the main thread didn't peek | project skills are listed and invokable by name, and their content reaches the model |
| Hook | `.parity/hooks.jsonl` exists in the thread's worktree with a `PostToolUse` entry for `mcp__parity__ping` | project hooks run, in the worktree, with the hook input on stdin, for MCP tools too |
| MCP server | `session.configured` shows `parity` as `connected`; the `mcp__parity__ping` tool item completed with this run's pong | project MCP servers start and their tools work, through Tenzo's permission prompt |
| Turn | the turn completed, with no runtime error, no prompt other than the MCP tool's, and no main-thread tool outside the four steps | the run is clean: nothing failed around the four |

The checks are pure functions over the events (`tools/parity/src/checks.ts`), unit-tested in `checks.test.ts`. `fixture.test.ts` copies the fixture the way the run does, then runs its MCP server and hook directly to keep them honest without Claude.

## Caveats

- **Workspace trust.** Claude Code ignores a project's `permissions.allow` until the workspace is trusted (the terminal prints *"Ignoring N permissions.allow entries … this workspace has not been trusted"*). A fresh temp copy is never trusted, so the MCP tool asks for permission, in the terminal and in Tenzo alike. That's why the fixture has no allow rules and the script answers the prompt: it also exercises Tenzo's permission round-trip. Trust is keyed by the main repo's path, not the worktree's (the warning names the repo), so a repo you trusted in the terminal stays trusted in Tenzo's worktrees.
- **MCP approval.** Without a person to ask, Claude Code (the SDK, `claude -p`) starts `.mcp.json` servers without approval. `enabledMcpjsonServers` is in the fixture so an interactive `claude` in the copy behaves the same, for comparison.
- **Background subagents.** Claude Code 2.1 runs `Agent` calls in the background by default: the tool result is "Async agent launched", and the subagent's answer arrives as its own messages. The check accepts that as well as a foreground result. `tenzo thread start/send` stop the session when the turn ends, so a background subagent still running then is stopped with it. Here it finishes first; the daemon (#6) keeps sessions alive.
- **Your config loads too.** The thread gets your user settings, plugins, skills and MCP connectors, as a real thread does. A user-level hook or permission rule can change the outcome; the table says which check it broke. Claude keeps its transcript of the run under `~/.claude/projects/`, as for any session.
- **The model can wander.** The prompt is explicit, but a small model can still skip a step or drop a codeword. A single failure where Claude didn't do what it was asked is the model, not Tenzo: re-run, or try `--model sonnet`. The same failure twice is a finding.