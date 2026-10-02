# Parity project

The test project of Tenzo's feature-parity check (`docs/PARITY.md`). `pnpm parity` copies this
folder to a temporary directory, makes it a git repo, and runs one Tenzo thread in it.

Everything here is ordinary project-level Claude Code configuration:

- `.claude/agents/parity-agent.md`: a subagent that answers `AGENT_CODEWORD=lantern-42`
- `.claude/skills/parity-skill/SKILL.md`: a skill whose codeword is `SKILL_CODEWORD=compass-17`
- `.claude/settings.json`: a `PostToolUse` hook (`.claude/hooks/record-tool.mjs`, appends to
  `.parity/hooks.jsonl`), the `.mcp.json` server approved, and the MCP tool and skill allowed
- `.mcp.json`: a stdio MCP server in plain Node (`.claude/mcp/parity-server.mjs`) with one tool,
  `ping`, that answers `pong:<word>:tenzo-parity-mcp`
