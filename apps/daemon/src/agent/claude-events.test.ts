import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeEvent } from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import type { EventDraft } from "./agent.ts";
import {
  boundedInput,
  type ClaudeTranslation,
  INPUT_STRING_LIMIT,
  initialTranslation,
  OUTPUT_LIMIT,
  startTurn,
  summarizeTool,
  toolKind,
  translate,
} from "./claude-events.ts";
import { assistant, init, result, SESSION, text, toolResult, toolUse } from "./claude-testing.ts";

const TURN = "11111111-1111-4111-8111-111111111111";

/** Feeds messages through the translator, collecting every event, as the adapter does. */
function run(messages: SDKMessage[], state = initialTranslation({ resumed: false })) {
  const events: EventDraft[] = [];
  for (const message of messages) {
    const next = translate(state, message);
    state = next.state;
    events.push(...next.events);
  }
  return { state, events };
}

function inTurn(): ClaudeTranslation {
  return startTurn(initialTranslation({ resumed: false }), TURN, "hi").state;
}

/** Every draft, once stamped, must be a valid contract event: this is what #6 persists. */
function expectValid(events: EventDraft[]) {
  for (const draft of events) {
    const stamped = {
      ...draft,
      eventId: "evt_abcdefghij0123456789",
      threadId: "thr_abcdefghij0123456789",
      agent: "claude",
      createdAt: "2026-10-02T12:00:00.000Z",
    };
    const parsed = RuntimeEvent.safeParse(stamped);
    expect(parsed.error, JSON.stringify(stamped)).toBeUndefined();
  }
}

describe("session events", () => {
  it("reports the session and what it loaded, once", () => {
    const { events, state } = run([init(), init()]);
    expect(events.map((e) => e.type)).toEqual(["session.started", "session.configured"]);
    expect(events[0]).toEqual({
      type: "session.started",
      payload: { sessionId: SESSION, resumed: false },
    });
    expect(events[1]?.payload).toEqual({
      model: "claude-haiku-4-5",
      cwd: "/tmp/worktree",
      permissionMode: "acceptEdits",
      agentVersion: "2.1.287",
      tools: ["Bash", "Edit", "Read", "AskUserQuestion", "mcp__notes__add"],
      mcpServers: [{ name: "notes", status: "connected" }],
      skills: ["pdf"],
      plugins: ["superpowers"],
      agents: ["general-purpose"],
    });
    expect(state.sessionStarted).toBe(true);
    expectValid(events);
  });

  it("reports what it loaded again when the model changed (Build it, thread.setModel)", () => {
    const { events, state } = run([init(), init(), init({ model: "claude-sonnet-5-5" }), init({ model: "claude-sonnet-5-5" })]);
    const configured = events.filter((e) => e.type === "session.configured");
    expect(configured.map((e) => e.payload.model)).toEqual(["claude-haiku-4-5", "claude-sonnet-5-5"]);
    expect(state.configured?.model).toBe("claude-sonnet-5-5");
    expectValid(events);
  });

  it("says when the session was resumed", () => {
    const { events } = run([init()], initialTranslation({ resumed: true }));
    expect(events[0]?.payload).toEqual({ sessionId: SESSION, resumed: true });
  });

  it("puts an init that arrives inside a turn on that turn", () => {
    const { events } = run([init()], inTurn());
    expect(events.every((e) => e.turnId === TURN)).toBe(true);
  });

  it("ignores messages a card doesn't need", () => {
    const quiet = [
      { type: "system", subtype: "status", status: "requesting", uuid: "u", session_id: SESSION },
      { type: "stream_event", event: {}, parent_tool_use_id: null, uuid: "u", session_id: SESSION },
      { type: "rate_limit_event", uuid: "u", session_id: SESSION },
      { type: "auth_status", isAuthenticating: true, output: [], uuid: "u", session_id: SESSION },
    ] as unknown as SDKMessage[];
    const state = inTurn();
    const out = run(quiet, state);
    expect(out.events).toEqual([]);
    expect(out.state).toBe(state);
  });

  it("reports a failed sign-in as an error", () => {
    const { events } = run([
      {
        type: "auth_status",
        isAuthenticating: false,
        output: [],
        error: "token expired",
        uuid: "u",
        session_id: SESSION,
      } as unknown as SDKMessage,
    ]);
    expect(events).toEqual([
      { type: "runtime.error", payload: { message: "Claude sign-in failed: token expired" } },
    ]);
  });
});

describe("turns", () => {
  it("starts a turn with the prompt as its first item", () => {
    const { state, events } = startTurn(initialTranslation({ resumed: false }), TURN, "Fix it");
    expect(state.turnId).toBe(TURN);
    expect(events).toEqual([
      { type: "turn.started", turnId: TURN, payload: { prompt: "Fix it" } },
      {
        type: "item.completed",
        turnId: TURN,
        itemId: TURN,
        payload: { itemType: "user_message", status: "completed", text: "Fix it" },
      },
    ]);
    expectValid(events);
  });

  it("completes the turn with Claude's answer, cost and duration", () => {
    const { state, events } = run([result({ user_message_uuids: [TURN] })], inTurn());
    expect(events).toEqual([
      {
        type: "turn.completed",
        turnId: TURN,
        payload: { state: "completed", result: "Done.", costUsd: 0.0021, durationMs: 1234 },
      },
    ]);
    expect(state.turnId).toBeNull();
    expectValid(events);
  });

  it("fails the turn, with an error first, when Claude reports one", () => {
    const { events } = run(
      [result({ is_error: true, result: "API Error: 401 invalid credentials" })],
      inTurn(),
    );
    expect(events).toEqual([
      {
        type: "runtime.error",
        turnId: TURN,
        payload: { message: "API Error: 401 invalid credentials" },
      },
      {
        type: "turn.completed",
        turnId: TURN,
        payload: {
          state: "failed",
          errorMessage: "API Error: 401 invalid credentials",
          costUsd: 0.0021,
          durationMs: 1234,
        },
      },
    ]);
    expectValid(events);
  });

  it("fails the turn on an error result, without Claude's internal diagnostics", () => {
    const { events } = run(
      [
        result({
          subtype: "error_max_turns",
          errors: ["[ede_diagnostic] internal", "Reached maximum number of turns (3)"],
        } as never),
      ],
      inTurn(),
    );
    expect(events.at(-1)?.payload).toMatchObject({
      state: "failed",
      errorMessage: "Reached maximum number of turns (3)",
    });
    const bare = run(
      [result({ subtype: "error_during_execution", errors: [] } as never)],
      inTurn(),
    );
    expect(bare.events.at(-1)?.payload).toMatchObject({ errorMessage: "error during execution" });
  });

  it("calls a stop at the spend cap Tenzo set a pause, not a failure", () => {
    const { events } = run(
      [
        result({
          subtype: "error_max_budget_usd",
          is_error: true,
          errors: ["Reached maximum budget ($0.50)"],
          total_cost_usd: 0.51,
        } as never),
      ],
      inTurn(),
    );
    expect(events.map((e) => e.type)).toEqual(["turn.completed"]);
    expect(events.at(-1)?.payload).toMatchObject({ state: "interrupted", stoppedBy: "budget", costUsd: 0.51 });
    expect(events.at(-1)?.payload).not.toHaveProperty("errorMessage");
  });

  it("calls an interrupted turn interrupted, not failed", () => {
    for (const message of [
      result({ terminal_reason: "aborted_tools", is_error: true }),
      result({ terminal_reason: "aborted_streaming" }),
      result({ subtype: "error_during_execution", errors: ["Request was interrupted"] } as never),
    ]) {
      const { events } = run([message], inTurn());
      expect(events.map((e) => e.type)).toEqual(["turn.completed"]);
      expect(events[0]?.payload).toMatchObject({ state: "interrupted" });
    }
  });

  it("leaves the turn open for a result that answers another prompt", () => {
    const state = inTurn();
    const out = run(
      [result({ user_message_uuids: ["22222222-2222-4222-8222-222222222222"] })],
      state,
    );
    expect(out.events).toEqual([]);
    expect(out.state.turnId).toBe(TURN);
  });

  it("doesn't let a turn Claude runs by itself close ours (resume with background work)", () => {
    // Our prompt waits in Claude's queue while it reports a background task from the last run.
    const own = assistant([text("The dev server you started earlier exited.")]);
    const reply = assistant([text("Here is my answer.")], { user_message_uuid: TURN });
    const { state, events } = run(
      [
        own,
        result({ origin: { kind: "peer", from: "background" }, result: "noted" } as never),
        reply,
        result({ user_message_uuids: [TURN], result: "Here is my answer." }),
      ],
      inTurn(),
    );
    expect(events.filter((e) => e.type.startsWith("turn."))).toEqual([
      expect.objectContaining({
        type: "turn.completed",
        turnId: TURN,
        payload: expect.objectContaining({ result: "Here is my answer." }),
      }),
    ]);
    expect(events.every((e) => e.turnId === TURN)).toBe(true); // no synthetic turn opened
    expect(state.turnId).toBeNull();
  });

  it("still closes our turn on a result that echoes nothing from a human (older CLIs)", () => {
    for (const message of [result(), result({ origin: { kind: "human" } } as never)]) {
      expect(run([message], inTurn()).events.map((e) => e.type)).toEqual(["turn.completed"]);
    }
  });

  it("closes a turn Claude started by itself on any result", () => {
    for (const end of [
      result({ origin: { kind: "peer", from: "x" } } as never),
      result({ user_message_uuids: ["33333333-3333-4333-8333-333333333333"] }),
    ]) {
      const own = assistant([text("Background task finished.")]);
      const { state, events } = run([own, end]);
      const turnId = (own as { uuid: string }).uuid;
      expect(events.map((e) => [e.type, e.turnId])).toEqual([
        ["turn.started", turnId],
        ["item.completed", turnId],
        ["turn.completed", turnId],
      ]);
      expect(state).toMatchObject({ turnId: null, synthetic: false });
    }
  });

  it("closes a turn Claude started by itself when we send a prompt; its late result is ignored", () => {
    const own = assistant([text("Watching the tests…")]);
    const ownTurn = (own as { uuid: string }).uuid;
    const before = run([own]).state;
    expect(before).toMatchObject({ turnId: ownTurn, synthetic: true });

    const started = startTurn(before, TURN, "next");
    expect(started.events.map((e) => [e.type, e.turnId])).toEqual([
      ["turn.completed", ownTurn],
      ["turn.started", TURN],
      ["item.completed", TURN],
    ]);
    expect(started.state).toMatchObject({ turnId: TURN, synthetic: false });
    expectValid(started.events);

    const { state, events } = run(
      [
        result({ origin: { kind: "peer", from: "x" } } as never), // Claude's own turn ending
        result({ user_message_uuids: [TURN] }),
      ],
      started.state,
    );
    expect(events.map((e) => [e.type, e.turnId])).toEqual([["turn.completed", TURN]]);
    expect(state.turnId).toBeNull();
  });

  it("ignores a result with no turn open (the resume handshake)", () => {
    expect(run([result({ num_turns: 0 })]).events).toEqual([]);
  });

  it("gives work Claude starts by itself a turn of its own", () => {
    const message = assistant([text("Background task finished.")]);
    const { state, events } = run([message, result()]);
    const turnId = (message as { uuid: string }).uuid;
    expect(events.map((e) => [e.type, e.turnId])).toEqual([
      ["turn.started", turnId],
      ["item.completed", turnId],
      ["turn.completed", turnId],
    ]);
    expect(state.turnId).toBeNull();
  });
});

describe("items", () => {
  it("turns assistant text and reasoning into completed items; skips empty blocks", () => {
    const message = assistant([
      { type: "thinking", thinking: "Let me look.", signature: "s" },
      text("I'll read the README."),
      text("  "),
      { type: "thinking", thinking: "", signature: "s" },
    ]);
    const { events } = run([message], inTurn());
    const uuid = (message as { uuid: string }).uuid;
    expect(events).toEqual([
      {
        type: "item.completed",
        turnId: TURN,
        itemId: `${uuid}:0`,
        payload: { itemType: "reasoning", status: "completed", text: "Let me look." },
      },
      {
        type: "item.completed",
        turnId: TURN,
        itemId: `${uuid}:1`,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          text: "I'll read the README.",
        },
      },
    ]);
    expectValid(events);
  });

  it("starts a tool item on tool_use and completes it on its result", () => {
    const { state, events } = run(
      [
        assistant([toolUse("toolu_1", "Bash", { command: "ls  -la\n", description: "List" })]),
        toolResult("toolu_1", "README.md\n"),
      ],
      inTurn(),
    );
    expect(events).toEqual([
      {
        type: "item.started",
        turnId: TURN,
        itemId: "toolu_1",
        payload: {
          itemType: "tool",
          status: "in_progress",
          text: "Bash: ls -la",
          toolKind: "command",
          toolName: "Bash",
          input: { command: "ls  -la\n", description: "List" },
        },
      },
      {
        type: "item.completed",
        turnId: TURN,
        itemId: "toolu_1",
        payload: {
          itemType: "tool",
          status: "completed",
          text: "Bash: ls -la",
          toolKind: "command",
          toolName: "Bash",
          output: "README.md\n",
        },
      },
    ]);
    expect(state.tools.size).toBe(0);
    expectValid(events);
  });

  it("marks a tool that errored as failed and trims long output", () => {
    const long = "x".repeat(OUTPUT_LIMIT + 50);
    const { events } = run(
      [
        assistant([toolUse("toolu_2", "Write", { file_path: "/w/a.txt", content: "a" })]),
        toolResult("toolu_2", [{ type: "text", text: long }], true),
      ],
      inTurn(),
    );
    const done = events[1];
    expect(done?.payload).toMatchObject({ status: "failed", toolKind: "file_change" });
    const output = (done?.payload as { output: string }).output;
    expect(output).toHaveLength(OUTPUT_LIMIT);
    expect(output.endsWith("…")).toBe(true);
  });

  it("still completes a tool it never saw start (e.g. from before a resume)", () => {
    const { events } = run([toolResult("toolu_old", "ok")], inTurn());
    expect(events[0]).toMatchObject({
      type: "item.completed",
      itemId: "toolu_old",
      payload: { itemType: "tool", status: "completed", toolName: "unknown", output: "ok" },
    });
    expectValid(events);
  });

  it("links a subagent's items to the subagent call, without starting a turn", () => {
    const { events } = run([
      assistant([toolUse("toolu_s", "Read", { file_path: "/w/README.md" })], {
        parent_tool_use_id: "toolu_agent",
      }),
      toolResult("toolu_s", "# app", false, { parent_tool_use_id: "toolu_agent" }),
    ]);
    expect(events.map((e) => e.type)).toEqual(["item.started", "item.completed"]);
    for (const event of events) {
      expect(event.payload).toMatchObject({ parentItemId: "toolu_agent", toolKind: "file_read" });
      expect(event.turnId).toBeUndefined();
    }
  });

  it("ignores prompt echoes and replays", () => {
    const echoes = [
      { type: "user", message: { role: "user", content: "hi" }, parent_tool_use_id: null },
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        isReplay: true,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "x" }],
        },
        parent_tool_use_id: null,
      },
    ] as unknown as SDKMessage[];
    expect(run(echoes, inTurn()).events).toEqual([]);
  });

  it("forgets unfinished tools when the turn ends", () => {
    const { state } = run(
      [
        assistant([toolUse("toolu_x", "Bash", { command: "sleep 100" })]),
        result({ terminal_reason: "aborted_tools" }),
      ],
      inTurn(),
    );
    expect(state.tools.size).toBe(0);
  });
});

describe("boundedInput", () => {
  it("keeps what a card needs and cuts the bulk", () => {
    const content = "x".repeat(10_000);
    const bounded = boundedInput({
      file_path: "/w/big.txt",
      content,
      replace_all: false,
      count: 3,
      edits: Array.from({ length: 100 }, (_, i) => ({ old_string: `a${i}`, new_string: `b${i}` })),
      small: { a: 1 },
    }) as Record<string, unknown>;
    expect(bounded.file_path).toBe("/w/big.txt");
    expect(bounded.content).toBe(`${"x".repeat(INPUT_STRING_LIMIT)}… (9700 more characters)`);
    expect(bounded).toMatchObject({ replace_all: false, count: 3, small: { a: 1 } });
    expect(typeof bounded.edits).toBe("string");
    expect((bounded.edits as string).startsWith('[{"old_string":"a0"')).toBe(true);
    expect(JSON.stringify(bounded).length).toBeLessThan(1000);
  });

  it("gives a command more room, and caps the number of fields", () => {
    const command = `echo ${"y".repeat(1500)}`;
    expect(boundedInput({ command })).toEqual({ command });
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(boundedInput(many) as object)).toHaveLength(20);
    expect(boundedInput("plain")).toBe("plain");
  });

  it("is what lands on item.started; the summary still reads the full input", () => {
    const content = "z".repeat(5000);
    const { events } = run(
      [assistant([toolUse("toolu_w", "Write", { file_path: "/w/a.txt", content })])],
      inTurn(),
    );
    const payload = events[0]?.payload as { input: { content: string }; text: string };
    expect(payload.input.content.length).toBeLessThan(400);
    expect(payload.text).toBe("Write: /w/a.txt");
  });
});

describe("toolKind and summarizeTool", () => {
  it("classifies Claude's tools", () => {
    expect(
      [
        "Bash",
        "Edit",
        "Write",
        "Read",
        "Grep",
        "WebFetch",
        "Agent",
        "Task",
        "mcp__gh__pr",
        "Skill",
      ].map(toolKind),
    ).toEqual([
      "command",
      "file_change",
      "file_change",
      "file_read",
      "file_read",
      "web",
      "subagent",
      "subagent",
      "mcp",
      "tool",
    ]);
  });

  it("summarizes a call in one readable line", () => {
    expect(summarizeTool("Edit", { file_path: "/w/src/app.ts", old_string: "a" })).toBe(
      "Edit: /w/src/app.ts",
    );
    expect(summarizeTool("Grep", { pattern: "TODO" })).toBe("Grep: TODO");
    expect(summarizeTool("WebSearch", { query: "svelte 5 runes" })).toBe(
      "WebSearch: svelte 5 runes",
    );
    expect(summarizeTool("Agent", { description: "Review the diff", prompt: "…" })).toBe(
      "Agent: Review the diff",
    );
    expect(summarizeTool("mcp__notes__add", { title: "x" })).toBe('mcp__notes__add: {"title":"x"}');
    expect(summarizeTool("TodoWrite", {})).toBe("TodoWrite");
    expect(summarizeTool("Bash", { command: "echo ".repeat(200) })).toHaveLength(300);
  });
});
