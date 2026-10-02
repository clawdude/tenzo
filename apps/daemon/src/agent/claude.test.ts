import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import {
  RuntimeEvent,
  type RuntimeEventOf,
  type RuntimeEventType,
  type ThreadId,
  TurnId,
} from "@tenzo/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { removeTempDirs, tempDir } from "../testing.ts";
import type { AgentSession } from "./agent.ts";
import { claudeEnv, createClaudeAdapter, findClaude, parseQuestions } from "./claude.ts";
import {
  assistant,
  fakeQuery,
  init,
  result,
  type Script,
  SESSION,
  text,
  toolResult,
  toolUse,
} from "./claude-testing.ts";

afterAll(removeTempDirs);

const THREAD = "thr_abcdefghij0123456789" as ThreadId;

function start(
  script: Script,
  input: { resumeSessionId?: string; model?: string } = {},
  exitError?: Error,
) {
  const fake = fakeQuery(script, exitError ? { exitError } : {});
  const adapter = createClaudeAdapter({ query: fake.query, claudePath: "/opt/bin/claude" });
  const session = adapter.start({ threadId: THREAD, cwd: "/w/thread", ...input });
  return { fake, session, events: reader(session) };
}

/** Reads a session's events one at a time, checking each against the contract. */
function reader(session: AgentSession) {
  const iterator = session.events[Symbol.asyncIterator]();
  const seen: RuntimeEvent[] = [];
  const next = async (): Promise<RuntimeEvent | undefined> => {
    const { value, done } = await iterator.next();
    if (done) return undefined;
    expect(RuntimeEvent.parse(value)).toEqual(value);
    expect(value.threadId).toBe(THREAD);
    seen.push(value);
    return value;
  };
  return {
    seen,
    next,
    /** Reads until an event of `type` arrives. */
    async until<T extends RuntimeEventType>(type: T): Promise<RuntimeEventOf<T>> {
      for (;;) {
        const event = await next();
        if (!event) throw new Error(`events ended before ${type}; saw ${seen.map((e) => e.type)}`);
        if (event.type === type) return event as RuntimeEventOf<T>;
      }
    },
    /** Reads everything until the session ends. */
    async rest(): Promise<RuntimeEvent[]> {
      const out: RuntimeEvent[] = [];
      for (let event = await next(); event; event = await next()) out.push(event);
      return out;
    },
  };
}

const simpleTurn: Script = function* () {
  yield init();
  yield assistant([
    toolUse("toolu_1", "Write", { file_path: "/w/thread/hello.txt", content: "hi" }),
  ]);
  yield toolResult("toolu_1", "File created");
  yield assistant([text("Created hello.txt.")]);
  yield result({ result: "Created hello.txt." });
};

describe("Claude adapter: starting", () => {
  it("runs the user's own claude with all their settings and Claude Code's own prompt", () => {
    const { fake, session } = start(simpleTurn);
    const options = fake.calls[0];
    expect(options).toMatchObject({
      cwd: "/w/thread",
      pathToClaudeCodeExecutable: "/opt/bin/claude",
      settingSources: ["user", "project", "local"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      permissionMode: "acceptEdits",
      sessionId: session.sessionId,
    });
    expect(TurnId.safeParse(session.sessionId).success).toBe(true); // a UUID, as Claude wants
    expect(options?.resume).toBeUndefined();
    // Nothing that would narrow what Claude Code can do: no tool lists, no replaced MCP servers,
    // agents, plugins, skills or settings, no append to its prompt. The environment is ours, only
    // scrubbed of a parent Claude Code session's variables.
    expect(options?.env).toEqual(claudeEnv(process.env));
    for (const key of [
      "tools",
      "allowedTools",
      "disallowedTools",
      "mcpServers",
      "strictMcpConfig",
      "agents",
      "plugins",
      "skills",
      "settings",
      "managedSettings",
      "hooks",
      "model",
    ]) {
      expect(options, key).not.toHaveProperty(key);
    }
    expect(options?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("drops a parent Claude Code session's variables and keeps the user's configuration", () => {
    const parent = {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SSE_PORT: "51234",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_SESSION_ATTENDED: "1",
      CLAUDE_PID: "42",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_BRIDGE_OWNER_ACCOUNT_UUID: "a",
      CLAUDE_CODE_BRIDGE_MCP_CARRIER: "c",
      CLAUDE_CODE_WORKER_EPOCH: "3",
      CLAUDE_CODE_EXECPATH: "/x/claude",
      CLAUDE_CODE_ENVIRONMENT_KIND: "bridge",
      CLAUDE_EFFORT: "high",
    };
    const user = {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://gw",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      HTTPS_PROXY: "http://proxy:8080",
      NO_PROXY: "localhost",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    };
    expect(claudeEnv({ ...parent, ...user, UNSET: undefined })).toEqual(user);
  });

  it("resumes a stored session instead of starting a new one", async () => {
    const { fake, session, events } = start(simpleTurn, {
      resumeSessionId: SESSION,
      model: "haiku",
    });
    expect(session.sessionId).toBe(SESSION);
    expect(fake.calls[0]).toMatchObject({ resume: SESSION, model: "haiku" });
    expect(fake.calls[0]).not.toHaveProperty("sessionId");
    session.sendTurn("go on");
    expect((await events.until("session.started")).payload).toEqual({
      sessionId: SESSION,
      resumed: true,
    });
    await session.stop();
  });

  function fakeClaude(dir: string): string {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
    chmodSync(join(dir, "claude"), 0o755);
    return join(dir, "claude");
  }

  it("finds claude on PATH, and says so when it isn't anywhere", () => {
    const empty = tempDir("bin-empty");
    const home = tempDir("home");
    mkdirSync(join(empty, "claude")); // a directory called claude is not the binary
    const onPath = fakeClaude(tempDir("bin"));
    expect(findClaude({ PATH: `${empty}:${onPath.slice(0, -7)}` }, home, [])).toBe(onPath);
    expect(() => findClaude({ PATH: empty }, home, [])).toThrow(
      /Can't find `claude` on PATH .* or set TENZO_CLAUDE_PATH/,
    );
  });

  it("falls back to where Claude Code installs itself when PATH lacks it (launchd)", () => {
    const home = tempDir("home");
    const system = tempDir("system");
    const inSystem = fakeClaude(system);
    expect(findClaude({ PATH: "/nowhere" }, home, [system])).toBe(inSystem);
    const local = fakeClaude(join(home, ".claude", "local"));
    expect(findClaude({}, home, [system])).toBe(local);
    const native = fakeClaude(join(home, ".local", "bin"));
    expect(findClaude({}, home, [system])).toBe(native);
  });

  it("uses TENZO_CLAUDE_PATH when set, and refuses a bad one", () => {
    const home = tempDir("home");
    fakeClaude(join(home, ".local", "bin"));
    const chosen = fakeClaude(tempDir("chosen"));
    expect(findClaude({ TENZO_CLAUDE_PATH: chosen }, home, [])).toBe(chosen);
    expect(() => findClaude({ TENZO_CLAUDE_PATH: "/no/claude" }, home, [])).toThrow(
      "TENZO_CLAUDE_PATH is /no/claude, which is not an executable file.",
    );
  });
});

describe("Claude adapter: a turn", () => {
  it("streams normalized events from prompt to result", async () => {
    const { session, events } = start(simpleTurn);
    const turnId = session.sendTurn("create hello.txt containing hi");
    const completed = await events.until("turn.completed");
    expect(completed).toMatchObject({ turnId, payload: { state: "completed" } });
    expect(events.seen.map((e) => e.type)).toEqual([
      "turn.started",
      "item.completed", // the prompt
      "session.started",
      "session.configured",
      "item.started", // Write
      "item.completed",
      "item.completed", // the answer
      "turn.completed",
    ]);
    expect(
      events.seen.filter((e) => e.type.startsWith("item.")).every((e) => e.turnId === turnId),
    ).toBe(true);
    expect(new Set(events.seen.map((e) => e.eventId)).size).toBe(events.seen.length);

    await session.stop();
    expect((await events.rest()).map((e) => e.type)).toEqual(["session.exited"]);
  });

  it("sends the turn id as the prompt's uuid so Claude's result can be matched to it", async () => {
    let sent: unknown;
    const { session } = start(function* (turn) {
      sent = turn.prompt;
      yield result();
    });
    const turnId = session.sendTurn("hello");
    await session.stop();
    expect(sent).toEqual({
      type: "user",
      message: { role: "user", content: "hello" },
      parent_tool_use_id: null,
      uuid: turnId,
    });
  });

  it("runs one turn at a time", async () => {
    const { session, events } = start(async function* () {
      yield result();
    });
    session.sendTurn("first");
    expect(() => session.sendTurn("second")).toThrow(/already running/);
    await events.until("turn.completed");
    expect(() => session.sendTurn("third")).not.toThrow();
    await session.stop();
    expect(() => session.sendTurn("fourth")).toThrow(/ended/);
  });

  it("takes a prompt while Claude runs a turn of its own, closing that turn", async () => {
    let prompts = 0;
    const own = assistant([text("Background task finished.")]);
    const { session, events } = start(function* () {
      prompts++;
      yield result();
      if (prompts === 1) yield own; // Claude goes on by itself after our turn
    });
    session.sendTurn("first");
    await events.until("turn.completed");
    const ownTurn = (await events.until("turn.started")).turnId;
    await events.until("item.completed");
    const second = session.sendTurn("second");
    expect(await events.next()).toMatchObject({ type: "turn.completed", turnId: ownTurn });
    expect(await events.next()).toMatchObject({ type: "turn.started", turnId: second });
    expect((await events.until("turn.completed")).turnId).toBe(second);
    await session.stop();
  });

  it("reports a crash as an error and ends the session", async () => {
    const { session, events } = start(function* () {
      yield init();
      throw new Error("Claude Code process exited with code 1");
    });
    session.sendTurn("hi");
    const error = await events.until("runtime.error");
    expect(error.payload.message).toMatch(/exited with code 1/);
    expect((await events.until("session.exited")).payload).toEqual({
      exitKind: "error",
      reason: "Claude Code process exited with code 1",
    });
    expect(await events.next()).toBeUndefined();
  });

  it("doesn't call it an error when Claude exits non-zero because we stopped it", async () => {
    const exit = new Error("Claude Code process exited with code 1");
    const { session, events } = start(simpleTurn, {}, exit);
    session.sendTurn("hi");
    await events.until("turn.completed");
    await session.stop();
    expect(await events.rest()).toEqual([
      expect.objectContaining({
        type: "session.exited",
        payload: { exitKind: "graceful", reason: "Claude Code process exited with code 1" },
      }),
    ]);
  });
});

describe("Claude adapter: questions", () => {
  const askColor = {
    questions: [
      {
        question: "Which color do you prefer?",
        header: "Color",
        options: [
          { label: "Red", description: "Warm" },
          { label: "Blue (Recommended)", description: "Cool", preview: "#0000ff" },
        ],
        multiSelect: false,
      },
    ],
  };

  function askingScript(outcome: { result?: PermissionResult | null }): Script {
    return async function* (turn) {
      yield init();
      yield assistant([toolUse("toolu_q", "AskUserQuestion", askColor)]);
      outcome.result = await turn.canUseTool("AskUserQuestion", askColor, "toolu_q");
      yield toolResult("toolu_q", "User answered");
      yield result();
    };
  }

  it("turns AskUserQuestion into user-input.requested, and the answer resumes the turn", async () => {
    const outcome: { result?: PermissionResult | null } = {};
    const { session, events } = start(askingScript(outcome));
    const turnId = session.sendTurn("ask me");

    const asked = await events.until("user-input.requested");
    expect(asked).toMatchObject({
      turnId,
      payload: {
        itemId: "toolu_q",
        questions: [
          {
            id: "Which color do you prefer?",
            header: "Color",
            question: "Which color do you prefer?",
            options: [
              { label: "Red", value: "Red", description: "Warm", recommended: false },
              {
                label: "Blue",
                value: "Blue (Recommended)",
                description: "Cool",
                recommended: true,
                preview: "#0000ff",
              },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    expect(asked.payload.questions[0]?.options[0]).not.toHaveProperty("preview");
    expect(() => session.respondToRequest(asked.requestId, "allow")).toThrow(/No open permission/);

    session.respondToUserInput(asked.requestId, { "Which color do you prefer?": "Blue" });
    const resolved = await events.until("user-input.resolved");
    expect(resolved).toMatchObject({
      requestId: asked.requestId,
      payload: { answers: { "Which color do you prefer?": "Blue" }, cancelled: false },
    });
    await events.until("turn.completed");
    expect(outcome.result).toEqual({
      behavior: "allow",
      updatedInput: { ...askColor, answers: { "Which color do you prefer?": "Blue" } },
    });
    expect(() => session.respondToUserInput(asked.requestId, {})).toThrow(/No open question/);
    await session.stop();
  });

  it("cancels an open question when the turn is interrupted", async () => {
    const outcome: { result?: PermissionResult | null } = {};
    const { fake, session, events } = start(askingScript(outcome));
    session.sendTurn("ask me");
    const asked = await events.until("user-input.requested");
    await session.interrupt();
    expect(fake.interrupts).toBe(1);
    expect((await events.until("user-input.resolved")).payload).toEqual({
      answers: {},
      cancelled: true,
    });
    await events.until("turn.completed");
    expect(outcome.result).toEqual({ behavior: "deny", message: "The user did not answer." });
    expect(() => session.respondToUserInput(asked.requestId, {})).toThrow(/No open question/);
    await session.stop();
  });

  it("reads AskUserQuestion input defensively", () => {
    expect(parseQuestions({})).toEqual([]);
    expect(
      parseQuestions({
        questions: [
          {
            options: [{ label: "A" }, "junk", { label: "(recommended) B", preview: "" }],
            multiSelect: "yes",
          },
          7,
        ],
      }),
    ).toEqual([
      {
        id: "q1",
        header: "",
        question: "",
        options: [
          { label: "A", value: "A", description: "", recommended: false },
          { label: "B", value: "(recommended) B", description: "", recommended: true },
        ],
        multiSelect: false,
      },
      { id: "q2", header: "", question: "", options: [], multiSelect: false },
    ]);
  });
});

describe("Claude adapter: permission requests", () => {
  const rmInput = { command: "rm -rf build", description: "Clean" };

  function permissionScript(outcome: { result?: PermissionResult | null }): Script {
    return async function* (turn) {
      yield init();
      yield assistant([toolUse("toolu_b", "Bash", rmInput)]);
      outcome.result = await turn.canUseTool("Bash", rmInput, "toolu_b");
      yield toolResult("toolu_b", "ok", outcome.result?.behavior !== "allow");
      yield result();
    };
  }

  it("turns a permission prompt into request.opened; allow resumes the tool", async () => {
    const outcome: { result?: PermissionResult | null } = {};
    const { session, events } = start(permissionScript(outcome));
    const turnId = session.sendTurn("clean up");

    const opened = await events.until("request.opened");
    expect(opened).toMatchObject({
      turnId,
      payload: {
        toolKind: "command",
        toolName: "Bash",
        detail: "Bash: rm -rf build",
        input: rmInput,
        itemId: "toolu_b",
      },
    });
    session.respondToRequest(opened.requestId, "allow");
    expect((await events.until("request.resolved")).payload).toEqual({ decision: "allow" });
    await events.until("turn.completed");
    expect(outcome.result).toEqual({ behavior: "allow", updatedInput: rmInput });
    await session.stop();
  });

  it("deny sends the person's reason back to Claude", async () => {
    const outcome: { result?: PermissionResult | null } = {};
    const { session, events } = start(permissionScript(outcome));
    session.sendTurn("clean up");
    const opened = await events.until("request.opened");
    session.respondToRequest(opened.requestId, "deny", "Use git clean instead");
    expect((await events.until("request.resolved")).payload).toEqual({
      decision: "deny",
      message: "Use git clean instead",
    });
    await events.until("turn.completed");
    expect(outcome.result).toEqual({ behavior: "deny", message: "Use git clean instead" });
    await session.stop();
  });

  it("leaves open requests unanswered when the session stops: session.exited says it", async () => {
    const outcome: { result?: PermissionResult | null } = {};
    const { session, events } = start(permissionScript(outcome));
    session.sendTurn("clean up");
    await events.until("request.opened");
    await session.stop();
    const rest = await events.rest();
    expect(rest.some((e) => e.type === "request.resolved")).toBe(false);
    expect(rest.at(-1)?.type).toBe("session.exited");
    expect(outcome.result).toEqual({ behavior: "deny", message: "The session ended." });
  });

  it("cancels open requests when the turn is interrupted", async () => {
    const outcome: { result?: PermissionResult | null } = {};
    const { session, events } = start(permissionScript(outcome));
    session.sendTurn("clean up");
    await events.until("request.opened");
    await session.interrupt();
    expect((await events.until("request.resolved")).payload).toEqual({ decision: "cancel" });
    await session.stop();
  });

  it("keeps a bounded copy of the input on the event; Claude gets the full input back", async () => {
    const big = { file_path: "/etc/hosts", content: "1.2.3.4 x\n".repeat(1000) };
    let answer: PermissionResult | null = null;
    const { session, events } = start(async function* (turn) {
      answer = await turn.canUseTool("Write", big, "toolu_w");
      yield result();
    });
    session.sendTurn("edit hosts");
    const opened = await events.until("request.opened");
    expect(opened.payload.toolKind).toBe("file_change");
    expect(JSON.stringify(opened.payload.input).length).toBeLessThan(500);
    expect(opened.payload.input).toMatchObject({ file_path: "/etc/hosts" });
    session.respondToRequest(opened.requestId, "allow");
    await events.until("turn.completed");
    expect(answer).toEqual({ behavior: "allow", updatedInput: big });
    await session.stop();
  });

  it("refuses an answer to a request that isn't open", () => {
    const { session } = start(simpleTurn);
    expect(() => session.respondToRequest("req_abcdefghij0123456789", "allow")).toThrow(
      /No open permission request "req_abcdefghij0123456789"/,
    );
  });
});
