import { RuntimeEvent } from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import {
  answerFor,
  type Check,
  checkParity,
  expectedPong,
  FIXTURE,
  formatTable,
  parityPrompt,
  parseEvents,
  parseHookLog,
  TENZO_SERVER,
  toolCalls,
} from "./checks.ts";

const WORD = "c0ffee42";
const TURN = "7538cedf-fd6b-4281-93b9-21bc3f067bc9";
let seq = 0;

/** A runtime event as `tenzo thread start --json` prints it, checked against the contract. */
function event(draft: Record<string, unknown>): RuntimeEvent {
  seq++;
  return RuntimeEvent.parse({
    eventId: `evt_${String(seq).padStart(20, "0")}`,
    threadId: "thr_0rqnpv974dn94eixmo7i",
    agent: "claude",
    createdAt: "2026-10-02T12:00:00.000Z",
    turnId: TURN,
    ...draft,
  });
}

function configured(overrides: Record<string, unknown> = {}): RuntimeEvent {
  return event({
    type: "session.configured",
    payload: {
      model: "claude-haiku-4-5",
      cwd: "/tmp/worktree",
      permissionMode: "acceptEdits",
      agentVersion: "2.1.287",
      tools: ["Agent", "Skill", FIXTURE.mcpTool, TENZO_SERVER.tool],
      mcpServers: [
        { name: "parity", status: "connected" },
        { name: "tenzo", status: "connected" },
      ],
      skills: ["caveman", FIXTURE.skill],
      plugins: [],
      agents: ["general-purpose", FIXTURE.agent],
      ...overrides,
    },
  });
}

/** A tool call: its start (with input) and its completion (with output). */
function tool(
  itemId: string,
  toolName: string,
  toolKind: string,
  input: Record<string, unknown>,
  output: string,
  status: "completed" | "failed" = "completed",
  parentItemId?: string,
): RuntimeEvent[] {
  const base = {
    itemType: "tool",
    text: toolName,
    toolKind,
    toolName,
    ...(parentItemId ? { parentItemId } : {}),
  };
  return [
    event({ type: "item.started", itemId, payload: { ...base, status: "in_progress", input } }),
    event({ type: "item.completed", itemId, payload: { ...base, status, output } }),
  ];
}

function message(itemId: string, text: string, parentItemId?: string): RuntimeEvent {
  return event({
    type: "item.completed",
    itemId,
    payload: {
      itemType: "assistant_message",
      status: "completed",
      text,
      ...(parentItemId ? { parentItemId } : {}),
    },
  });
}

function permission(toolName: string): RuntimeEvent[] {
  const requestId = `req_${String(++seq).padStart(20, "0")}`;
  return [
    event({
      type: "request.opened",
      requestId,
      payload: { toolKind: "mcp", toolName, detail: `${toolName}: {}`, input: {} },
    }),
    event({ type: "request.resolved", requestId, payload: { decision: "allow" } }),
  ];
}

function completed(payload: Record<string, unknown> = {}): RuntimeEvent {
  return event({
    type: "turn.completed",
    payload: { state: "completed", costUsd: 0.0412, durationMs: 12_300, ...payload },
  });
}

/** What a passing run looks like, recorded from a real haiku run (trimmed). */
function passingRun(): RuntimeEvent[] {
  return [
    configured(),
    event({ type: "turn.started", payload: { prompt: parityPrompt(WORD) } }),
    ...tool(
      "toolu_skill",
      "Skill",
      "tool",
      { skill: FIXTURE.skill },
      "Launching skill: parity-skill",
    ),
    ...tool(
      "toolu_agent",
      "Agent",
      "subagent",
      { subagent_type: FIXTURE.agent, description: "Get the codeword", prompt: "Codeword?" },
      "Async agent launched successfully.\nagentId: a34ef382e3e9ac810",
    ),
    message("msg_sub:0", "AGENT_CODEWORD=lantern-42", "toolu_agent"),
    ...tool("toolu_search", "ToolSearch", "tool", { query: `select:${FIXTURE.mcpTool}` }, ""),
    event({
      type: "item.started",
      itemId: "toolu_mcp",
      payload: {
        itemType: "tool",
        status: "in_progress",
        toolKind: "mcp",
        toolName: FIXTURE.mcpTool,
        input: { word: WORD },
      },
    }),
    ...permission(FIXTURE.mcpTool),
    event({
      type: "item.completed",
      itemId: "toolu_mcp",
      payload: {
        itemType: "tool",
        status: "completed",
        toolKind: "mcp",
        toolName: FIXTURE.mcpTool,
        output: expectedPong(WORD),
      },
    }),
    message("msg_main:0", `compass-17 lantern-42 ${expectedPong(WORD)}`),
    completed({ result: `compass-17 lantern-42 ${expectedPong(WORD)}` }),
  ];
}

const HOOKS = parseHookLog(
  [
    '{"hook":"PostToolUse","tool":"Skill"}',
    '{"hook":"PostToolUse","tool":"Agent"}',
    '{"hook":"PostToolUse","tool":"mcp__parity__ping"}',
  ].join("\n"),
);

function byName(checks: Check[]): Record<string, Check> {
  return Object.fromEntries(checks.map((c) => [c.name, c]));
}

describe("checkParity", () => {
  it("passes a run where all four worked", () => {
    const checks = checkParity(passingRun(), HOOKS, WORD);
    expect(checks.map((c) => [c.name, c.pass])).toEqual([
      ["Subagent", true],
      ["Skill", true],
      ["Hook", true],
      ["MCP server", true],
      ["Tenzo's server", true],
      ["Turn", true],
    ]);
    const c = byName(checks);
    expect(c.Subagent?.detail).toContain("background");
    expect(c.Hook?.detail).toContain("3×");
    expect(c.Turn?.detail).toContain(`allowed ${FIXTURE.mcpTool} when asked (1×)`);
  });

  it("takes a foreground subagent's answer from the tool result", () => {
    const events = [
      configured(),
      ...tool(
        "toolu_agent",
        "Agent",
        "subagent",
        { subagent_type: FIXTURE.agent },
        "AGENT_CODEWORD=lantern-42",
      ),
    ];
    const subagent = byName(checkParity(events, HOOKS, WORD)).Subagent;
    expect(subagent).toMatchObject({ pass: true, detail: expect.stringContaining("returned") });
  });

  it("fails the subagent when it isn't loaded, isn't run, or its answer never shows", () => {
    const notLoaded = checkParity([configured({ agents: ["general-purpose"] })], HOOKS, WORD);
    expect(byName(notLoaded).Subagent?.detail).toBe(
      "parity-agent isn't loaded; agents: general-purpose",
    );

    const otherAgent = [
      configured(),
      ...tool("toolu_x", "Agent", "subagent", { subagent_type: "Explore" }, "done"),
    ];
    expect(byName(checkParity(otherAgent, HOOKS, WORD)).Subagent?.detail).toBe(
      "Claude never ran parity-agent; subagents run: Explore",
    );

    const silent = [
      configured(),
      ...tool(
        "toolu_agent",
        "Agent",
        "subagent",
        { subagent_type: FIXTURE.agent },
        "Async agent launched",
      ),
      message("msg_other:0", "lantern-42"), // the main agent saying it is not the subagent's answer
    ];
    const check = byName(checkParity(silent, HOOKS, WORD)).Subagent;
    expect(check?.pass).toBe(false);
    expect(check?.detail).toContain("never reached the thread");
  });

  it("fails the skill when it isn't listed, isn't invoked, or its content never shows", () => {
    expect(
      byName(checkParity([configured({ skills: ["caveman"] })], HOOKS, WORD)).Skill?.detail,
    ).toBe("parity-skill isn't listed; skills: caveman");

    expect(byName(checkParity([configured()], HOOKS, WORD)).Skill?.detail).toBe(
      "listed, but Claude never invoked parity-skill",
    );

    const noContent = [
      configured(),
      ...tool("toolu_skill", "Skill", "tool", { skill: FIXTURE.skill }, "Launching skill"),
      completed({ result: "done" }),
    ];
    expect(byName(checkParity(noContent, HOOKS, WORD)).Skill?.pass).toBe(false);
  });

  it("fails the hook without a log or without a PostToolUse entry", () => {
    expect(byName(checkParity(passingRun(), null, WORD)).Hook?.detail).toContain("it never ran");
    const other = parseHookLog('{"hook":"PreToolUse","tool":"Skill"}\n');
    expect(byName(checkParity(passingRun(), other, WORD)).Hook?.pass).toBe(false);
  });

  it("fails the hook when it never ran for the MCP tool", () => {
    const builtInOnly = parseHookLog(
      '{"hook":"PostToolUse","tool":"Skill"}\n{"hook":"PostToolUse","tool":"Agent"}\n',
    );
    expect(byName(checkParity(passingRun(), builtInOnly, WORD)).Hook?.detail).toBe(
      "no PostToolUse entry for mcp__parity__ping; only Skill, Agent",
    );
  });
});

describe("codewords taken from the fixture's files", () => {
  /** A passing run, plus whatever else the main thread did before its reply. */
  function runWith(...extra: RuntimeEvent[]): RuntimeEvent[] {
    const events = passingRun();
    return [...events.slice(0, -2), ...extra, ...events.slice(-2)];
  }

  it("fail Skill, Subagent and Turn when the main thread reads a file", () => {
    const read = tool(
      "toolu_read",
      "Read",
      "file_read",
      { file_path: "/w/.claude/skills/parity-skill/SKILL.md" },
      "SKILL_CODEWORD=compass-17",
    );
    const c = byName(checkParity(runWith(...read), HOOKS, WORD));
    expect(c.Skill).toEqual({
      name: "Skill",
      pass: false,
      detail: "can't trust the codeword: the main thread used Read",
    });
    expect(c.Subagent?.detail).toBe("can't trust the codeword: the main thread used Read");
    expect(c.Turn?.detail).toBe("the main thread used Read: not part of the check");
    expect(c.Hook?.pass).toBe(true);
    expect(c["MCP server"]?.pass).toBe(true);
  });

  it("fail when an allowed tool is pointed at .claude/", () => {
    const agent = tool(
      "toolu_agent2",
      "Agent",
      "subagent",
      { subagent_type: "general-purpose", prompt: "Print .claude/agents/parity-agent.md" },
      "done",
    );
    const c = byName(checkParity(runWith(...agent), HOOKS, WORD));
    expect(c.Skill?.detail).toBe("can't trust the codeword: Agent was pointed at .claude/");
    expect(c.Subagent?.pass).toBe(false);
    expect(c.Turn?.pass).toBe(false);
  });

  it("fail Subagent when the codeword is in the Agent call's own input", () => {
    const events = [
      configured(),
      ...tool(
        "toolu_agent",
        "Agent",
        "subagent",
        { subagent_type: FIXTURE.agent, prompt: "Say AGENT_CODEWORD=lantern-42" },
        "AGENT_CODEWORD=lantern-42",
      ),
    ];
    expect(byName(checkParity(events, HOOKS, WORD)).Subagent?.detail).toBe(
      "the codeword was in Agent's own input, not from the subagent",
    );
  });

  it("let the subagent use its own tools", () => {
    const inside = tool(
      "toolu_sub_read",
      "Read",
      "file_read",
      { file_path: "/w/README.md" },
      "# Parity project",
      "completed",
      "toolu_agent",
    );
    const checks = checkParity(runWith(...inside), HOOKS, WORD);
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it("fails the MCP server when it isn't connected or the tool didn't answer the pong", () => {
    const failed = checkParity(
      [configured({ mcpServers: [{ name: "parity", status: "failed" }] })],
      HOOKS,
      WORD,
    );
    expect(byName(failed)["MCP server"]?.detail).toBe("parity is failed");

    const missing = checkParity([configured({ mcpServers: [] })], HOOKS, WORD);
    expect(byName(missing)["MCP server"]?.detail).toBe("parity isn't loaded; servers: none");

    const denied = [
      configured(),
      ...tool(
        "toolu_mcp",
        FIXTURE.mcpTool,
        "mcp",
        { word: WORD },
        "The user doesn't want to proceed",
        "failed",
      ),
    ];
    expect(byName(checkParity(denied, HOOKS, WORD))["MCP server"]?.detail).toContain("failed");

    // A pong for another word is a stale or guessed answer, not this run's call.
    const stale = [
      configured(),
      ...tool("toolu_mcp", FIXTURE.mcpTool, "mcp", { word: WORD }, expectedPong("other")),
    ];
    expect(byName(checkParity(stale, HOOKS, WORD))["MCP server"]?.pass).toBe(false);
  });

  it("fails Tenzo's server unless it and the user's server are both connected, its tools listed", () => {
    const tenzo = (overrides: Record<string, unknown>) =>
      byName(checkParity([configured(overrides)], HOOKS, WORD))["Tenzo's server"];
    expect(byName(checkParity(passingRun(), HOOKS, WORD))["Tenzo's server"]?.detail).toBe(
      "tenzo connected beside parity, mcp__tenzo__propose listed",
    );
    // Tenzo's server in place of the user's: the injection replaced their config.
    expect(tenzo({ mcpServers: [{ name: "tenzo", status: "connected" }] })?.detail).toBe(
      "parity isn't loaded; servers: tenzo",
    );
    expect(tenzo({ mcpServers: [{ name: "parity", status: "connected" }] })?.detail).toBe(
      "tenzo isn't loaded; servers: parity",
    );
    expect(
      tenzo({
        mcpServers: [
          { name: "parity", status: "connected" },
          { name: "tenzo", status: "failed" },
        ],
      })?.detail,
    ).toBe("tenzo is failed");
    expect(tenzo({ tools: ["Agent", "Skill", FIXTURE.mcpTool] })?.detail).toBe(
      "tenzo connected, but mcp__tenzo__propose isn't listed",
    );
  });

  it("fails the turn on a proposal: the check changes nothing, so there is nothing to propose", () => {
    const proposal = event({
      type: "proposal.requested",
      requestId: "req_00000000000000000098",
      payload: { headline: "Tidy the fixture", summary: "Tidy it." },
    });
    expect(answerFor(proposal)).toBeNull();
    expect(byName(checkParity([...passingRun(), proposal], HOOKS, WORD)).Turn?.detail).toBe(
      "asked for a go-ahead for: Tidy the fixture: not part of the check",
    );
  });

  it("fails the turn on other prompts, errors, or a turn that didn't complete", () => {
    const bash = [...passingRun(), ...permission("Bash")];
    expect(byName(checkParity(bash, HOOKS, WORD)).Turn?.detail).toContain("permission for Bash");

    const interrupted = [configured(), completed({ state: "interrupted" })];
    expect(byName(checkParity(interrupted, HOOKS, WORD)).Turn?.detail).toBe("interrupted");

    const errored = [
      configured(),
      event({ type: "runtime.error", payload: { message: "Claude sign-in failed" } }),
    ];
    expect(byName(checkParity(errored, HOOKS, WORD)).Turn?.detail).toBe(
      "error: Claude sign-in failed",
    );

    expect(byName(checkParity([], HOOKS, WORD)).Turn?.detail).toBe("the turn never completed");
  });

  it("fails everything that needs the configuration when the session never started", () => {
    const checks = byName(checkParity([], null, WORD));
    for (const name of ["Subagent", "Skill", "MCP server", "Tenzo's server"]) {
      expect(checks[name]?.detail).toBe("the session never reported its configuration");
    }
  });
});

describe("answerFor", () => {
  it("allows the fixture's MCP tool, denies anything else, and won't answer questions", () => {
    const [mcp] = permission(FIXTURE.mcpTool);
    const [bash] = permission("Bash");
    expect(answerFor(mcp as RuntimeEvent)).toBe("y");
    expect(answerFor(bash as RuntimeEvent)).toBe("Not part of the parity check.");
    const question = event({
      type: "user-input.requested",
      requestId: "req_00000000000000000099",
      payload: { questions: [] },
    });
    expect(answerFor(question)).toBeNull();
    expect(answerFor(completed())).toBeUndefined();
  });
});

describe("parsing", () => {
  it("reads events from --json output, skipping anything else", () => {
    const [first, second] = passingRun();
    const stdout = `${JSON.stringify(first)}\nnot json\n{broken\n${JSON.stringify(second)}\n`;
    expect(parseEvents(stdout)).toEqual([first, second]);
  });

  it("reads the hook log, skipping torn lines; no file is null", () => {
    expect(parseHookLog(null)).toBeNull();
    expect(parseHookLog('{"hook":"PostToolUse","tool":"Skill"}\n{"hook":\n42\n')).toEqual([
      { hook: "PostToolUse", tool: "Skill" },
    ]);
  });

  it("joins a tool call's start and completion", () => {
    const calls = toolCalls(passingRun());
    expect(calls.find((c) => c.toolName === FIXTURE.mcpTool)).toMatchObject({
      input: { word: WORD },
      status: "completed",
      output: expectedPong(WORD),
    });
  });
});

describe("parityPrompt", () => {
  it("names all four and carries the run's word", () => {
    const prompt = parityPrompt(WORD);
    for (const name of [FIXTURE.skill, FIXTURE.agent, FIXTURE.mcpTool, WORD]) {
      expect(prompt).toContain(name);
    }
    // The codewords are the fixture's secrets: the prompt must not give them away.
    expect(prompt).not.toContain(FIXTURE.agentCodeword);
    expect(prompt).not.toContain(FIXTURE.skillCodeword);
  });
});

describe("formatTable", () => {
  it("prints one row per check and a verdict", () => {
    const table = formatTable([
      { name: "Hook", pass: true, detail: "ran" },
      { name: "MCP server", pass: false, detail: "parity is failed" },
    ]);
    expect(table).toBe(
      [
        "Check       Result  Detail",
        "Hook        PASS    ran",
        "MCP server  FAIL    parity is failed",
        "",
        "FAIL: 1 of 2 checks failed.",
      ].join("\n"),
    );
  });
});
