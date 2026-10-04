import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
import type { AgentSession, StartSessionInput } from "./agent.ts";
import { type ListenerDirs, lsofListenerDirs } from "../live.ts";
import { claudeEnv, createClaudeAdapter, findClaude, parseQuestions } from "./claude.ts";
import { fingerprintOf } from "./fingerprint.ts";
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

const PROMPTS = { discuss: "Talk first.", build: "Build it now." };

function start(
  script: Script,
  input: Partial<Omit<StartSessionInput, "threadId" | "cwd">> = {},
  exitError?: Error,
) {
  const fake = fakeQuery(script, exitError ? { exitError } : {});
  const adapter = createClaudeAdapter({ query: fake.query, claudePath: "/opt/bin/claude" });
  const session = adapter.start({
    threadId: THREAD,
    cwd: "/w/thread",
    phase: "building",
    prompts: PROMPTS,
    ...input,
  });
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
  it("runs the user's own claude with all their settings, Claude Code's prompt and Tenzo's after it", () => {
    const { fake, session } = start(simpleTurn, { phase: "discussing" });
    const options = fake.calls[0];
    expect(options).toMatchObject({
      cwd: "/w/thread",
      pathToClaudeCodeExecutable: "/opt/bin/claude",
      settingSources: ["user", "project", "local"],
      sessionId: session.sessionId,
    });
    expect(TurnId.safeParse(session.sessionId).success).toBe(true); // a UUID, as Claude wants
    expect(options?.resume).toBeUndefined();
    // Claude Code's own system prompt, Tenzo's thread prompt appended: added to, never replaced.
    expect(options?.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: PROMPTS.discuss,
    });
    // One MCP server added, Tenzo's, in process. The user's own servers load from their settings
    // as in a terminal: no strictMcpConfig, nothing else in mcpServers.
    expect(Object.keys(options?.mcpServers ?? {})).toEqual(["tenzo"]);
    expect(options?.mcpServers?.tenzo).toMatchObject({ type: "sdk", name: "tenzo" });
    // Nothing that would narrow what Claude Code can do: no tool lists, no replaced agents,
    // plugins, skills or settings, and no permission mode: the user's own defaultMode applies.
    // The environment is ours, only scrubbed of a parent Claude Code session's variables, plus
    // the thread's live base for `expose`.
    expect(options?.env).toEqual({ ...claudeEnv(process.env), TENZO_LIVE_BASE: `/live/${THREAD}/` });
    for (const key of [
      "permissionMode",
      "allowDangerouslySkipPermissions",
      "tools",
      "allowedTools",
      "disallowedTools",
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
  });

  it("builds and reviews with the build prompt, in the user's own permission mode", () => {
    for (const phase of ["building", "review"] as const) {
      const { fake } = start(simpleTurn, { phase });
      expect(fake.calls[0]).toMatchObject({
        systemPrompt: { type: "preset", preset: "claude_code", append: PROMPTS.build },
      });
      expect(fake.calls[0]).not.toHaveProperty("permissionMode");
    }
  });

  it("appends nothing when it has no prompts", () => {
    const fake = fakeQuery(simpleTurn);
    const adapter = createClaudeAdapter({ query: fake.query, claudePath: "/opt/bin/claude" });
    adapter.start({ threadId: THREAD, cwd: "/w/thread", phase: "discussing" });
    expect(fake.calls[0]?.systemPrompt).toEqual({ type: "preset", preset: "claude_code" });
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

  it("fingerprints the full input: requests shown alike still differ", async () => {
    const long = "x".repeat(2100);
    const safe = { command: `${long} && echo ok!` };
    const evil = { command: `${long} && rm -rf ~` };
    const { session, events } = start(async function* (turn) {
      await turn.canUseTool("Bash", safe, "toolu_1");
      await turn.canUseTool("Bash", evil, "toolu_2");
      yield result();
    });
    session.sendTurn("build");
    const first = await events.until("request.opened");
    session.respondToRequest(first.requestId, "allow");
    const second = await events.until("request.opened");
    session.respondToRequest(second.requestId, "deny");
    expect(second.payload.input).toEqual(first.payload.input);
    expect(first.payload.fingerprint).toBe(fingerprintOf("Bash", safe));
    expect(second.payload.fingerprint).toBe(fingerprintOf("Bash", evil));
    expect(second.payload.fingerprint).not.toBe(first.payload.fingerprint);
    await session.stop();
  });

  it("refuses an answer to a request that isn't open", () => {
    const { session } = start(simpleTurn);
    expect(() => session.respondToRequest("req_abcdefghij0123456789", "allow")).toThrow(
      /No open permission request "req_abcdefghij0123456789"/,
    );
  });
});

describe("Claude adapter: Tenzo's propose tool", () => {
  const plan = {
    headline: "Add CONTRIBUTING.md",
    summary: "Add CONTRIBUTING.md with three rules.\nCheck: the file renders.",
  };

  /** Claude calls propose over MCP, then ends the turn with what the tool told it. */
  function proposing(outcome: { reply?: { text: string; isError: boolean } }): Script {
    return async function* (turn) {
      yield init();
      yield assistant([toolUse("toolu_p", "mcp__tenzo__propose", plan)]);
      // Claude asks canUseTool first; Tenzo's own tools never become a permission card.
      const allowed = await turn.canUseTool("mcp__tenzo__propose", plan, "toolu_p");
      expect(allowed).toEqual({ behavior: "allow", updatedInput: plan });
      outcome.reply = await turn.callTool("tenzo", "propose", plan);
      yield toolResult("toolu_p", outcome.reply.text, outcome.reply.isError);
      yield result();
    };
  }

  it("waits for Build it, then tells Claude to build, with the build prompt, in the same mode", async () => {
    const outcome: { reply?: { text: string; isError: boolean } } = {};
    const { fake, session, events } = start(proposing(outcome), { phase: "discussing" });
    const turnId = session.sendTurn("add a CONTRIBUTING.md");

    const requested = await events.until("proposal.requested");
    expect(requested).toMatchObject({ turnId, payload: plan });
    expect(requested.payload.fingerprint).toBe(fingerprintOf("mcp__tenzo__propose", plan));
    expect(events.seen.some((e) => e.type === "request.opened")).toBe(false);
    // The call is still waiting: nothing has come back to Claude.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(outcome.reply).toBeUndefined();
    expect(() => session.respondToRequest(requested.requestId, "allow")).toThrow(/No open permission/);

    session.respondToProposal(requested.requestId, "build");
    expect((await events.until("proposal.resolved")).payload).toEqual({ decision: "build" });
    await events.until("turn.completed");
    expect(outcome.reply).toEqual({
      text: `Approved, build it.\n\n${PROMPTS.build}`,
      isError: false,
    });
    // The approval carries the build prompt; the permission mode stays the user's own.
    expect(fake.permissionModes).toEqual([]);
    expect(() => session.respondToProposal(requested.requestId, "build")).toThrow(/No open proposal/);
    await session.stop();
  });

  it("Change something sends the note back and asks for a new proposal", async () => {
    const outcome: { reply?: { text: string; isError: boolean } } = {};
    const { fake, session, events } = start(proposing(outcome), { phase: "discussing" });
    session.sendTurn("add a CONTRIBUTING.md");
    const requested = await events.until("proposal.requested");
    session.respondToProposal(requested.requestId, "change", "Five rules, not three");
    expect((await events.until("proposal.resolved")).payload).toEqual({
      decision: "change",
      note: "Five rules, not three",
    });
    await events.until("turn.completed");
    expect(outcome.reply).toEqual({
      text: "Not yet. Five rules, not three\n\nRevise, and propose again.",
      isError: false,
    });
    expect(fake.permissionModes).toEqual([]);
    await session.stop();
  });

  it("withdraws the proposal when the turn is interrupted", async () => {
    const outcome: { reply?: { text: string; isError: boolean } } = {};
    const { session, events } = start(proposing(outcome), { phase: "discussing" });
    session.sendTurn("add a CONTRIBUTING.md");
    await events.until("proposal.requested");
    await session.interrupt();
    expect((await events.until("proposal.resolved")).payload).toEqual({ decision: "cancel" });
    await session.stop();
  });

  it("leaves the proposal open when the session stops: answering it resumes the thread", async () => {
    const outcome: { reply?: { text: string; isError: boolean } } = {};
    const { session, events } = start(proposing(outcome), { phase: "discussing" });
    session.sendTurn("add a CONTRIBUTING.md");
    await events.until("proposal.requested");
    await session.stop();
    const rest = await events.rest();
    expect(rest.some((e) => e.type === "proposal.resolved")).toBe(false);
    expect(rest.at(-1)?.type).toBe("session.exited");
  });

  it("makes a headline from the summary when Claude gives none", async () => {
    const { session, events } = start(
      async function* (turn) {
        await turn.callTool("tenzo", "propose", {
          summary: "## Plan\nRename the flag to --dry. Then update the docs.",
        });
        yield result();
      },
      { phase: "discussing" },
    );
    session.sendTurn("rename the flag");
    const requested = await events.until("proposal.requested");
    // A heading alone is not a headline: the first line that says something is.
    expect(requested.payload.headline).toBe("Rename the flag to --dry.");
    await session.stop();
  });

  it("turns away a second proposal while one waits: one proposal card per thread", async () => {
    const replies: { text: string; isError: boolean }[] = [];
    const { session, events } = start(
      async function* (turn) {
        yield init();
        const first = turn.callTool("tenzo", "propose", plan);
        await new Promise((resolve) => setTimeout(resolve, 10));
        replies.push(await turn.callTool("tenzo", "propose", { summary: "Something else." }));
        replies.push(await first);
        yield result();
      },
      { phase: "discussing" },
    );
    session.sendTurn("add a CONTRIBUTING.md");
    const requested = await events.until("proposal.requested");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringMatching(/already waiting/) });
    session.respondToProposal(requested.requestId, "build");
    await events.until("turn.completed");
    expect(replies[1]?.isError).toBe(false);
    expect(events.seen.filter((e) => e.type === "proposal.requested")).toHaveLength(1);
    await session.stop();
  });
});

describe("Claude adapter: report, attach, expose", () => {
  type Reply = { text: string; isError: boolean };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  /** Claude calls Tenzo's tools one after another in a turn; the replies are collected. */
  async function calls(
    list: [string, Record<string, unknown>][],
    input: Partial<Omit<StartSessionInput, "threadId" | "cwd">> & {
      cwd?: string;
      listenerDirs?: ListenerDirs;
    } = {},
  ) {
    const replies: Reply[] = [];
    const fake = fakeQuery(async function* (turn) {
      yield init();
      for (const [name, args] of list) replies.push(await turn.callTool("tenzo", name, args));
      yield result();
    });
    const cwd = input.cwd ?? "/w/thread";
    const adapter = createClaudeAdapter({
      query: fake.query,
      claudePath: "/opt/bin/claude",
      // Unless a test says otherwise, the dev server runs in the worktree.
      listenerDirs: input.listenerDirs ?? (async () => [cwd]),
    });
    const session = adapter.start({
      threadId: THREAD,
      cwd,
      phase: "building",
      prompts: PROMPTS,
      ...input,
    });
    const events = reader(session);
    session.sendTurn("build it");
    await events.until("turn.completed");
    await session.stop();
    await events.rest();
    return { replies, events: events.seen };
  }

  function worktree() {
    const root = tempDir("wt");
    const outside = tempDir("outside");
    writeFileSync(join(root, "shot.png"), PNG);
    writeFileSync(join(outside, "secret.png"), PNG);
    return { root, outside, store: join(tempDir("home"), "attachments", THREAD) };
  }

  it("report hands over finished work at once, tidied", async () => {
    const { replies, events } = await calls([
      [
        "report",
        {
          headline: "  Counter   works ",
          summary: " Added a counter page. ",
          how_to_test: "Open /counter and tap.",
          checks: [
            { name: "Tests", status: "pass", detail: "3 passed" },
            { name: "Lint", status: "skipped", detail: "  " },
          ],
        },
      ],
    ]);
    expect(replies[0]).toMatchObject({ isError: false, text: expect.stringMatching(/^Reported/) });
    const reported = events.find((e) => e.type === "report.submitted");
    expect(reported?.payload).toEqual({
      headline: "Counter works",
      summary: "Added a counter page.",
      howToTest: "Open /counter and tap.",
      checks: [
        { name: "Tests", status: "pass", detail: "3 passed" },
        { name: "Lint", status: "skipped" },
      ],
    });
  });

  it("report refuses a check status it doesn't know", async () => {
    const { replies, events } = await calls([
      ["report", { summary: "x", how_to_test: "", checks: [{ name: "Tests", status: "green" }] }],
    ]);
    expect(replies[0]?.isError).toBe(true);
    expect(events.some((e) => e.type === "report.submitted")).toBe(false);
  });

  it("attach copies an image from the worktree and says what it took", async () => {
    const wt = worktree();
    mkdirSync(join(wt.root, "shots"));
    writeFileSync(join(wt.root, "shots", "home.png"), PNG);
    const { replies, events } = await calls(
      [
        ["attach", { path: "shot.png", caption: "The counter" }],
        ["attach", { path: join(wt.root, "shots", "home.png") }],
      ],
      { cwd: wt.root, attachmentsDir: wt.store },
    );
    expect(replies.map((r) => r.isError)).toEqual([false, false]);
    const added = events.filter((e) => e.type === "attachment.added");
    expect(added.map((e) => e.payload.attachment)).toMatchObject([
      { name: "shot.png", caption: "The counter", mediaType: "image/png", bytes: PNG.length },
      { name: "home.png", mediaType: "image/png" },
    ]);
    for (const e of added) {
      expect(readFileSync(join(wt.store, e.payload.attachment.file))).toEqual(PNG);
    }
  });

  it("attach refuses anything outside the worktree, symlinks and traversal included", async () => {
    const wt = worktree();
    symlinkSync(join(wt.outside, "secret.png"), join(wt.root, "link.png"));
    symlinkSync(wt.outside, join(wt.root, "linked-dir"));
    const { replies, events } = await calls(
      [
        ["attach", { path: "../outside/secret.png" }],
        ["attach", { path: join(wt.outside, "secret.png") }],
        ["attach", { path: "link.png" }],
        ["attach", { path: "linked-dir/secret.png" }],
        ["attach", { path: `shot.png/../../${wt.outside.split("/").pop()}/secret.png` }],
      ],
      { cwd: wt.root, attachmentsDir: wt.store },
    );
    for (const reply of replies) {
      expect(reply).toMatchObject({ isError: true });
    }
    expect(replies[1]?.text).toMatch(/outside this thread's worktree/);
    expect(replies[2]?.text).toMatch(/outside this thread's worktree/);
    expect(events.some((e) => e.type === "attachment.added")).toBe(false);
  });

  it("attach takes images only, small enough, and real files", async () => {
    const wt = worktree();
    writeFileSync(join(wt.root, "page.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    writeFileSync(join(wt.root, "notes.png"), "not an image");
    writeFileSync(join(wt.root, "huge.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    mkdirSync(join(wt.root, "dir.png"));
    const { replies } = await calls(
      [
        ["attach", { path: "page.svg" }],
        ["attach", { path: "notes.png" }],
        ["attach", { path: "huge.png" }],
        ["attach", { path: "dir.png" }],
        ["attach", { path: "missing.png" }],
      ],
      { cwd: wt.root, attachmentsDir: wt.store },
    );
    expect(replies.map((r) => r.isError)).toEqual([true, true, true, true, true]);
    expect(replies[0]?.text).toMatch(/not a PNG, JPEG, GIF or WebP/);
    expect(replies[2]?.text).toMatch(/limit is 10.0 MB/);
    expect(replies[3]?.text).toMatch(/not a file/);
    expect(replies[4]?.text).toMatch(/no file/);
  });

  it("expose registers a port that answers under the thread's base", async () => {
    const base = `/live/${THREAD}/`;
    const server = await listen((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        req.url?.startsWith(base)
          ? `<script type="module" src="${base}src/main.js"></script>`
          : '<script src="/src/main.js"></script>',
      );
    });
    try {
      const { replies, events } = await calls([
        ["expose", { port: server.port, path: "/counter" }],
      ]);
      expect(replies[0]).toMatchObject({ isError: false });
      expect(replies[0]?.text).toContain(`${base}counter`);
      expect(replies[0]?.text).not.toMatch(/Warning/);
      expect(events.find((e) => e.type === "preview.exposed")?.payload).toEqual({
        port: server.port,
        path: "counter",
      });
    } finally {
      server.close();
    }
  });

  it("expose warns when the page points outside the base", async () => {
    const server = await listen((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end('<script type="module" src="/@vite/client"></script>');
    });
    try {
      const { replies, events } = await calls([["expose", { port: server.port }]]);
      expect(replies[0]?.isError).toBe(false);
      expect(replies[0]?.text).toMatch(/Warning: The page loads \/@vite\/client, outside/);
      expect(events.some((e) => e.type === "preview.exposed")).toBe(true);
    } finally {
      server.close();
    }
  });

  it("expose refuses bad ports, paths out of the base, and a port nobody answers on", async () => {
    const free = await listen(() => {});
    free.close(); // a port that was free a moment ago: nothing answers there now
    const { replies, events } = await calls([
      ["expose", { port: 80 }],
      ["expose", { port: 70_000 }],
      ["expose", { port: 5173.5 }],
      ["expose", { port: 5173, path: "../../api/commands" }],
      ["expose", { port: 5173, path: "https://evil.example/" }],
      ["expose", { port: free.port }],
    ]);
    expect(replies.map((r) => r.isError)).toEqual([true, true, true, true, true, true]);
    expect(replies[0]?.text).toMatch(/1024–65535/);
    expect(replies[3]?.text).toMatch(/not a page under the live base/);
    expect(replies[5]?.text).toMatch(/Nothing answers on localhost/);
    expect(events.some((e) => e.type === "preview.exposed")).toBe(false);
  });

  it("report waits for Build it: before, it is refused and nothing reaches the Pass", async () => {
    const report = { summary: "Done.", how_to_test: "", checks: [] };
    const early = await calls([["report", report]], { phase: "discussing" });
    expect(early.replies[0]).toMatchObject({ isError: true, text: expect.stringMatching(/propose first/) });
    expect(early.events.some((e) => e.type === "report.submitted")).toBe(false);

    // Approved in the same session: from then on it reports.
    const replies: Reply[] = [];
    const { session, events } = start(
      async function* (turn) {
        yield init();
        await turn.callTool("tenzo", "propose", { summary: "Add it." });
        replies.push(await turn.callTool("tenzo", "report", report));
        yield result();
      },
      { phase: "discussing" },
    );
    session.sendTurn("go");
    session.respondToProposal((await events.until("proposal.requested")).requestId, "build");
    await events.until("report.submitted");
    await events.until("turn.completed");
    expect(replies[0]?.isError).toBe(false);
    await session.stop();
  });

  it("report refuses a check name of only spaces", async () => {
    const { replies } = await calls([
      ["report", { summary: "x", how_to_test: "", checks: [{ name: "  ", status: "pass" }] }],
      ["report", { summary: "   ", how_to_test: "", checks: [] }],
    ]);
    expect(replies.map((r) => r.isError)).toEqual([true, true]);
  });

  it("attach counts what the thread already holds for its report", async () => {
    const wt = worktree();
    const { replies } = await calls(
      [
        ["attach", { path: "shot.png" }],
        ["attach", { path: "shot.png" }],
      ],
      { cwd: wt.root, attachmentsDir: wt.store, pendingAttachments: 7 },
    );
    expect(replies.map((r) => r.isError)).toEqual([false, true]);
    expect(replies[1]?.text).toMatch(/at most 8/);
  });

  it("attach refuses a hard link: the same file can have a name outside", async () => {
    const wt = worktree();
    linkSync(join(wt.outside, "secret.png"), join(wt.root, "hard.png"));
    const { replies, events } = await calls([["attach", { path: "hard.png" }]], {
      cwd: wt.root,
      attachmentsDir: wt.store,
    });
    expect(replies[0]).toMatchObject({ isError: true, text: expect.stringMatching(/hard link/) });
    expect(events.some((e) => e.type === "attachment.added")).toBe(false);
  });

  it("expose takes only a server running in this worktree, and never Tenzo itself", async () => {
    const page = await listen((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(`<script src="/live/${THREAD}/main.js"></script>`);
    });
    const tenzo = await listen((_req, res) => {
      res.setHeader("x-tenzo-daemon", "1");
      res.statusCode = 404;
      res.end();
    });
    try {
      const elsewhere = await calls([["expose", { port: page.port }]], {
        listenerDirs: async () => ["/Users/someone/other-project"],
      });
      expect(elsewhere.replies[0]).toMatchObject({
        isError: true,
        text: expect.stringMatching(/other-project, outside this worktree/),
      });
      const unknown = await calls([["expose", { port: page.port }]], { listenerDirs: async () => [] });
      expect(unknown.replies[0]?.text).toMatch(/Can't tell which process/);
      const inside = await calls([["expose", { port: page.port }]], {
        listenerDirs: async () => ["/w/thread/app"],
      });
      expect(inside.replies[0]?.isError).toBe(false);
      // No lsof on the machine: unchecked, as documented.
      const unchecked = await calls([["expose", { port: page.port }]], { listenerDirs: async () => null });
      expect(unchecked.replies[0]?.isError).toBe(false);
      const self = await calls([["expose", { port: tenzo.port }]]);
      expect(self.replies[0]).toMatchObject({ isError: true, text: expect.stringMatching(/is Tenzo itself/) });
      for (const run of [elsewhere, unknown, self]) {
        expect(run.events.some((e) => e.type === "preview.exposed")).toBe(false);
      }
    } finally {
      page.close();
      tenzo.close();
    }
  });
});

describe("lsofListenerDirs", () => {
  it("finds the working directory of the process listening on a port", async (ctx) => {
    const server = await listen(() => {});
    try {
      const dirs = await lsofListenerDirs(server.port);
      if (dirs === null) return ctx.skip(); // no lsof here
      expect(dirs.map((d) => realpathSync(d))).toContain(realpathSync(process.cwd()));
    } finally {
      server.close();
    }
  });
});

/** A throwaway HTTP server on a free loopback port. */
function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => server.close() });
    });
  });
}
