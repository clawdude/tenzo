import type { ThreadId, UserInputQuestion } from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import { createClaudeAdapter } from "./agent/claude.ts";
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
} from "./agent/claude-testing.ts";
import { askQuestions, formatEvent, runTurn, titleFrom } from "./thread-run.ts";
import type { Thread } from "./threads.ts";

const thread: Thread = {
  id: "thr_abcdefghij0123456789" as ThreadId,
  projectId: "prj_abcdefghij0123456789",
  title: "t",
  slug: "t",
  branch: "tenzo/t",
  worktreePath: "/w/thread",
  status: "active",
  createdAt: "2026-10-02T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  archivedAt: null,
  agent: null,
  sessionId: null,
};

const color: UserInputQuestion = {
  id: "Which color?",
  header: "Color",
  question: "Which color?",
  options: [
    { label: "Red", description: "Warm", recommended: false },
    { label: "Blue", description: "Cool", recommended: true },
  ],
  multiSelect: false,
};

/** Answers prompts from a list, then reports end of input. */
function keyboard(...replies: string[]) {
  const asked: string[] = [];
  return {
    asked,
    ask: async (prompt: string) => {
      asked.push(prompt);
      return replies.shift() ?? null;
    },
  };
}

async function run(script: Script, replies: string[], t: Thread = thread) {
  const fake = fakeQuery(script);
  const keys = keyboard(...replies);
  const lines: string[] = [];
  const sessions: string[] = [];
  const outcome = await runTurn({
    adapter: createClaudeAdapter({ query: fake.query, claudePath: "/opt/bin/claude" }),
    thread: t,
    prompt: "do it",
    model: "haiku",
    onSession: (id) => sessions.push(id),
    ask: keys.ask,
    print: (line) => lines.push(line),
  });
  return { ...outcome, fake, lines, sessions, asked: keys.asked };
}

describe("runTurn", () => {
  it("runs one turn in the thread's worktree, prints its events and reports the session", async () => {
    const out = await run(function* () {
      yield init();
      yield assistant([text("Hello.")]);
      yield result();
    }, []);
    expect(out.state).toBe("completed");
    expect(out.sessions).toEqual([SESSION]);
    expect(out.fake.calls[0]).toMatchObject({ cwd: "/w/thread", model: "haiku" });
    expect(out.fake.calls[0]).not.toHaveProperty("resume");
    expect(out.lines.map((l) => l.split(" ")[0])).toEqual([
      "turn.started",
      "item.completed",
      "session.started",
      "session.configured",
      "item.completed",
      "turn.completed",
      "session.exited",
    ]);
    expect(out.asked).toEqual([]);
  });

  it("resumes the thread's stored session", async () => {
    const out = await run(
      function* () {
        yield init();
        yield result();
      },
      [],
      { ...thread, agent: "claude", sessionId: SESSION },
    );
    expect(out.fake.calls[0]).toMatchObject({ resume: SESSION });
    expect(out.sessionId).toBe(SESSION);
  });

  it("asks the keyboard for answers and permission, and passes them to Claude", async () => {
    const results: unknown[] = [];
    const out = await run(
      async function* (turn) {
        yield init();
        results.push(await turn.canUseTool("AskUserQuestion", { questions: [color] }, "toolu_q"));
        results.push(await turn.canUseTool("Bash", { command: "make" }, "toolu_1"));
        results.push(await turn.canUseTool("Bash", { command: "make install" }, "toolu_2"));
        results.push(await turn.canUseTool("Bash", { command: "rm -rf /" }, "toolu_3"));
        yield result();
      },
      ["2", "y", "n", "Never do that"],
    );
    expect(results).toEqual([
      {
        behavior: "allow",
        updatedInput: { questions: [color], answers: { "Which color?": "Blue" } },
      },
      { behavior: "allow", updatedInput: { command: "make" } },
      { behavior: "deny", message: "The user denied this." },
      { behavior: "deny", message: "Never do that" },
    ]);
    expect(out.asked[1]).toBe("? Allow Bash: make? [y]es, [n]o, or type why not: ");
    expect(out.state).toBe("completed");
  });

  it("interrupts the turn when nobody is there to answer", async () => {
    const out = await run(async function* (turn) {
      yield init();
      yield assistant([toolUse("toolu_q", "AskUserQuestion", { questions: [color] })]);
      const answer = await turn.canUseTool("AskUserQuestion", { questions: [color] }, "toolu_q");
      yield toolResult("toolu_q", answer?.behavior ?? "", true);
      yield result({ terminal_reason: "aborted_tools", is_error: true });
    }, []);
    expect(out.fake.interrupts).toBe(1);
    expect(out.state).toBe("interrupted");
    expect(out.lines).toContain("user-input.resolved  cancelled");
  });

  it("prints JSON lines with --json", async () => {
    const fake = fakeQuery(function* () {
      yield result();
    });
    const lines: string[] = [];
    await runTurn({
      adapter: createClaudeAdapter({ query: fake.query, claudePath: "/opt/bin/claude" }),
      thread,
      prompt: "hi",
      json: true,
      onSession: () => {},
      ask: async () => null,
      print: (line) => lines.push(line),
    });
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      "turn.started",
      "item.completed",
      "turn.completed",
      "session.exited",
    ]);
  });
});

describe("askQuestions", () => {
  it("takes an option by number or free text, and asks again on a bad number", async () => {
    const keys = keyboard("", "7", "1");
    expect(await askQuestions([color], keys.ask)).toEqual({ "Which color?": "Red" });
    expect(keys.asked).toHaveLength(3);
    expect(keys.asked[0]).toBe(
      "? Which color?  [Color]\n  1. Red — Warm\n  2. Blue (recommended) — Cool\n  A number, or type your own answer: ",
    );
    expect(await askQuestions([color], keyboard("Green, please").ask)).toEqual({
      "Which color?": "Green, please",
    });
  });

  it("joins several picks for a multi-select question", async () => {
    const multi = { ...color, multiSelect: true };
    expect(await askQuestions([multi], keyboard("1, 2").ask)).toEqual({
      "Which color?": "Red, Blue",
    });
    expect(await askQuestions([color], keyboard("1,2", "2").ask)).toEqual({
      "Which color?": "Blue",
    });
  });

  it("gives up at end of input", async () => {
    expect(await askQuestions([color, color], keyboard("1").ask)).toBeNull();
  });
});

describe("formatEvent and titleFrom", () => {
  it("prints one readable line per event", () => {
    const base = {
      eventId: "evt_abcdefghij0123456789",
      threadId: thread.id,
      agent: "claude" as const,
      createdAt: "2026-10-02T00:00:00.000Z",
    };
    expect(
      formatEvent({
        ...base,
        type: "turn.completed",
        turnId: "11111111-1111-4111-8111-111111111111",
        payload: { state: "completed", costUsd: 0.01234, durationMs: 5700 },
      }),
    ).toBe("turn.completed       completed · $0.0123 · 5.7s");
    expect(
      formatEvent({
        ...base,
        type: "item.completed",
        itemId: "toolu_1",
        payload: {
          itemType: "tool",
          status: "failed",
          text: "Bash: make",
          parentItemId: "toolu_a",
        },
      }),
    ).toBe("item.completed         ↳ ✗ Bash: make");
    expect(
      formatEvent({
        ...base,
        type: "request.resolved",
        requestId: "req_abcdefghij0123456789",
        payload: { decision: "deny", message: "no" },
      }),
    ).toBe("request.resolved     deny: no");
  });

  it("titles a thread after the first line of its prompt", () => {
    expect(titleFrom("  Fix the login bug\nDetails follow")).toBe("Fix the login bug");
    const long = `Refactor ${"the payment provider ".repeat(6)}`;
    const title = titleFrom(long);
    expect(title.length).toBeLessThanOrEqual(81);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });
});
