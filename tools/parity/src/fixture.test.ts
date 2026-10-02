import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { expectedPong, FIXTURE, parseHookLog } from "./checks.ts";
import { copyFixture, FIXTURE_DIR, INERT_NAMES } from "./fixture.ts";

/** The fixture's own moving parts, run directly on a live copy: no Claude involved. */
const scratch = mkdtempSync(join(tmpdir(), "tenzo-parity-fixture-"));
const PROJECT = join(scratch, "parity-project");
copyFixture(PROJECT);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the stored fixture", () => {
  it("is inert in this repo and live once copied", () => {
    for (const [stored, live] of Object.entries(INERT_NAMES)) {
      expect(existsSync(join(FIXTURE_DIR, stored))).toBe(true);
      expect(existsSync(join(FIXTURE_DIR, live))).toBe(false);
      expect(existsSync(join(PROJECT, live))).toBe(true);
      expect(existsSync(join(PROJECT, stored))).toBe(false);
    }
  });
});

describe("the fixture's MCP server", () => {
  it("speaks enough MCP for Claude Code: initialize, tools/list, tools/call", () => {
    const mcp = JSON.parse(readFileSync(join(PROJECT, ".mcp.json"), "utf8"));
    const server = mcp.mcpServers[FIXTURE.mcpServer];
    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "ping", arguments: { word: "w1" } },
      },
      { jsonrpc: "2.0", id: 4, method: "resources/list" },
    ];
    const result = spawnSync(server.command, server.args, {
      cwd: PROJECT, // Claude Code starts project servers in the project
      input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const replies = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies.map((r) => r.id)).toEqual([1, 2, 3, 4]); // nothing for the notification
    expect(replies[0].result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
    });
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual(["ping"]);
    expect(`mcp__${FIXTURE.mcpServer}__${replies[1].result.tools[0].name}`).toBe(FIXTURE.mcpTool);
    expect(replies[2].result.content).toEqual([{ type: "text", text: expectedPong("w1") }]);
    expect(replies[3].error.code).toBe(-32601);
  });
});

describe("the fixture's hook", () => {
  it("is a PostToolUse hook that appends the tool to .parity/hooks.jsonl", () => {
    const settings = JSON.parse(readFileSync(join(PROJECT, ".claude/settings.json"), "utf8"));
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain("record-tool.mjs");
    expect(settings.enabledMcpjsonServers).toEqual([FIXTURE.mcpServer]);

    const project = mkdtempSync(join(tmpdir(), "tenzo-parity-hook-"));
    dirs.push(project);
    const hook = join(PROJECT, ".claude/hooks/record-tool.mjs");
    for (const tool of ["Skill", FIXTURE.mcpTool]) {
      const result = spawnSync(process.execPath, [hook], {
        input: JSON.stringify({ hook_event_name: "PostToolUse", tool_name: tool, tool_input: {} }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: project },
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
    }
    const log = readFileSync(join(project, FIXTURE.hookLog), "utf8");
    expect(parseHookLog(log)).toEqual([
      { hook: "PostToolUse", tool: "Skill" },
      { hook: "PostToolUse", tool: FIXTURE.mcpTool },
    ]);
  });
});

describe("the fixture's subagent and skill", () => {
  it("define the names and codewords the checks look for", () => {
    const agent = readFileSync(join(PROJECT, ".claude/agents/parity-agent.md"), "utf8");
    expect(agent).toContain(`name: ${FIXTURE.agent}\n`);
    expect(agent).toContain(FIXTURE.agentCodeword);
    const skill = readFileSync(join(PROJECT, `.claude/skills/${FIXTURE.skill}/SKILL.md`), "utf8");
    expect(skill).toContain(`name: ${FIXTURE.skill}\n`);
    expect(skill).toContain(FIXTURE.skillCodeword);
  });
});
