import {
  type EnvironmentId,
  QueueItem,
  type RequestId,
  type RuntimeEvent,
  type ThreadId,
  type TurnId,
  type UserInputQuestion,
} from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_LIMIT,
  ERROR_LIMIT,
  errorRequestId,
  type FoldState,
  foldEvent,
  foldEvents,
  INITIAL_STATE,
  itemIdFor,
  trimContext,
} from "./fold.ts";

const ENV = "env_abcdefghij0123456789" as EnvironmentId;
const THREAD = "thr_abcdefghij0123456789" as ThreadId;
const TURN = "11111111-1111-4111-8111-111111111111" as TurnId;
const TURN2 = "22222222-2222-4222-8222-222222222222" as TurnId;
const REQ1 = "req_aaaaaaaaaaaaaaaaaaaa" as RequestId;
const REQ2 = "req_bbbbbbbbbbbbbbbbbbbb" as RequestId;

let clock = 0;
function ev(event: Record<string, unknown>): RuntimeEvent {
  clock++;
  return {
    eventId: `evt_${String(clock).padStart(20, "0")}`,
    threadId: THREAD,
    agent: "claude",
    createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, clock)).toISOString(),
    ...event,
  } as RuntimeEvent;
}

const color: UserInputQuestion = {
  id: "Which color?",
  header: "Color",
  question: "Which color?",
  options: [
    { label: "Red", value: "Red", description: "Warm", recommended: false },
    { label: "Blue", value: "Blue (Recommended)", description: "Cool", recommended: true },
  ],
  multiSelect: false,
};
const size: UserInputQuestion = {
  id: "Which size?",
  header: "Size",
  question: "Which size?",
  options: [{ label: "S", value: "S", description: "", recommended: false }],
  multiSelect: false,
};

const started = (sessionId = "sess-1") =>
  ev({ type: "session.started", payload: { sessionId, resumed: false } });
const turnStarted = (turnId = TURN) =>
  ev({ type: "turn.started", turnId, payload: { prompt: "go" } });
const said = (text: string, extra: Record<string, unknown> = {}) =>
  ev({
    type: "item.completed",
    turnId: TURN,
    itemId: `msg_${clock}`,
    payload: { itemType: "assistant_message", status: "completed", text, ...extra },
  });
const asked = (requestId = REQ1, questions = [color]) =>
  ev({ type: "user-input.requested", turnId: TURN, requestId, payload: { questions } });
const answered = (requestId = REQ1, answers = { "Which color?": "Blue (Recommended)" }) =>
  ev({ type: "user-input.resolved", turnId: TURN, requestId, payload: { answers, cancelled: false } });
const permission = (requestId = REQ2, extra: Record<string, unknown> = {}) =>
  ev({
    type: "request.opened",
    turnId: TURN,
    requestId,
    payload: {
      toolKind: "command",
      toolName: "Bash",
      detail: "Bash: rm -rf build",
      input: { command: "rm -rf build" },
      ...extra,
    },
  });
const decided = (requestId = REQ2, decision = "allow", message?: string) =>
  ev({
    type: "request.resolved",
    turnId: TURN,
    requestId,
    payload: { decision, ...(message ? { message } : {}) },
  });
const exited = (exitKind = "error") =>
  ev({ type: "session.exited", turnId: TURN, payload: { exitKind } });
const completed = (turnId = TURN) =>
  ev({ type: "turn.completed", turnId, payload: { state: "completed" } });

function fold(...events: RuntimeEvent[]) {
  return foldEvents(events, ENV);
}

describe("foldEvent: questions", () => {
  it("opens a quick-lane item with context, ask, options and the suggested answer", () => {
    const { state, items } = fold(
      started(),
      turnStarted(),
      said("I read the repo.\n\nBefore I start, one thing decides the design."),
      asked(),
    );
    expect(items).toHaveLength(1);
    const item = items[0] as QueueItem;
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      id: itemIdFor(REQ1),
      environmentId: ENV,
      threadId: THREAD,
      lane: "quick",
      kind: "question",
      requestId: REQ1,
      turnId: TURN,
      context: "I read the repo.\nBefore I start, one thing decides the design.",
      ask: "Which color?",
      options: color.options,
      suggested: "Blue (Recommended)",
      questions: [color],
      status: "open",
      detached: false,
      resolution: null,
    });
    expect(item.createdAt).toMatch(/^2026-10-02T12:00/);
    expect(state.open).toEqual([item]);
  });

  it("has no suggestion when no option is recommended, and an empty context when nothing was said", () => {
    const plain = { ...color, options: color.options.map((o) => ({ ...o, recommended: false })) };
    const { items } = fold(started(), turnStarted(), asked(REQ1, [plain]));
    expect(items[0]?.suggested).toBeNull();
    expect(items[0]?.context).toBe("");
  });

  it("takes context from the main agent only, and from the current turn", () => {
    const { items } = fold(
      started(),
      turnStarted(),
      said("Old turn text."),
      completed(),
      turnStarted(TURN2),
      said("Inside a subagent", { parentItemId: "toolu_task" }),
      asked(),
    );
    expect(items[0]?.context).toBe("");
  });

  it("carries every question of a multi-question ask; the first is the headline", () => {
    const { items } = fold(started(), turnStarted(), asked(REQ1, [color, size]));
    expect(items[0]).toMatchObject({ ask: "Which color?", questions: [color, size] });
  });

  it("resolves the item with the answers; it leaves the open queue", () => {
    const { state, items } = fold(started(), turnStarted(), asked(), answered());
    expect(state.open).toEqual([]);
    expect(items[0]).toMatchObject({
      status: "resolved",
      resolution: { kind: "answered", answers: { "Which color?": "Blue (Recommended)" } },
    });
    expect(items[0]?.resolvedAt).not.toBeNull();
  });

  it("marks a cancelled question cancelled (an interrupt)", () => {
    const cancelled = ev({
      type: "user-input.resolved",
      turnId: TURN,
      requestId: REQ1,
      payload: { answers: {}, cancelled: true },
    });
    const { state, items } = fold(started(), turnStarted(), asked(), cancelled);
    expect(state.open).toEqual([]);
    expect(items[0]?.resolution).toEqual({ kind: "cancelled" });
  });
});

describe("foldEvent: permission requests", () => {
  it("opens an Allow/Deny item; allowing is the suggestion", () => {
    const { items } = fold(
      started(),
      turnStarted(),
      said("Cleaning up."),
      permission(REQ2, { reason: "outside the worktree" }),
    );
    expect(QueueItem.parse(items[0])).toEqual(items[0]);
    expect(items[0]).toMatchObject({
      kind: "permission",
      ask: "Allow Bash: rm -rf build?",
      context: "Cleaning up.",
      suggested: "allow",
      options: [
        { label: "Allow", value: "allow" },
        { label: "Deny", value: "deny" },
      ],
      questions: [],
      permission: {
        toolKind: "command",
        toolName: "Bash",
        detail: "Bash: rm -rf build",
        reason: "outside the worktree",
        input: { command: "rm -rf build" },
      },
    });
  });

  it("uses the agent's own sentence for the ask when it gave one", () => {
    const { items } = fold(started(), permission(REQ2, { title: "Claude wants to delete build/" }));
    expect(items[0]?.ask).toBe("Claude wants to delete build/");
  });

  it.each([
    ["allow", undefined, { kind: "allowed" }],
    ["deny", "use git clean", { kind: "denied", message: "use git clean" }],
    ["deny", undefined, { kind: "denied" }],
    ["cancel", undefined, { kind: "cancelled" }],
  ])("resolves %s (%s)", (decision, message, resolution) => {
    const { state, items } = fold(started(), permission(), decided(REQ2, decision, message));
    expect(state.open).toEqual([]);
    expect(items[0]?.resolution).toEqual(resolution);
  });
});

const REQ3 = "req_cccccccccccccccccccc" as RequestId;
const proposed = (requestId = REQ3) =>
  ev({
    type: "proposal.requested",
    turnId: TURN,
    requestId,
    payload: {
      headline: "Add CONTRIBUTING.md",
      summary: "Add CONTRIBUTING.md with three rules.\nCheck: it renders.",
    },
  });
const proposalAnswered = (decision: string, note?: string, requestId = REQ3) =>
  ev({
    type: "proposal.resolved",
    turnId: TURN,
    requestId,
    payload: { decision, ...(note ? { note } : {}) },
  });

describe("foldEvent: proposals and the thread's phase", () => {
  it("a thread starts discussing", () => {
    expect(fold(started()).state.runtime.phase).toBe("discussing");
  });

  it("opens a quick-lane proposal item: the headline is the ask, Build it the suggestion", () => {
    const { items, state } = fold(started(), turnStarted(), said("I read the repo."), proposed());
    expect(QueueItem.parse(items[0])).toEqual(items[0]);
    expect(items[0]).toMatchObject({
      kind: "proposal",
      lane: "quick",
      ask: "Add CONTRIBUTING.md",
      context: "I read the repo.",
      options: [{ label: "Build it", value: "build", recommended: true }],
      suggested: "build",
      questions: [],
      proposal: {
        headline: "Add CONTRIBUTING.md",
        summary: "Add CONTRIBUTING.md with three rules.\nCheck: it renders.",
      },
    });
    expect(state.runtime.phase).toBe("discussing");
  });

  it("Build it resolves the item approved and the thread is building", () => {
    const { items, state } = fold(started(), turnStarted(), proposed(), proposalAnswered("build"));
    expect(state.open).toEqual([]);
    expect(items[0]?.resolution).toEqual({ kind: "approved" });
    expect(state.runtime.phase).toBe("building");
  });

  it("Change something resolves it with the note; the thread keeps discussing", () => {
    const { items, state } = fold(
      started(),
      turnStarted(),
      proposed(),
      proposalAnswered("change", "Five rules"),
    );
    expect(items[0]?.resolution).toEqual({ kind: "revise", note: "Five rules" });
    expect(state.runtime.phase).toBe("discussing");
  });

  it("a withdrawn proposal is cancelled and changes nothing", () => {
    const { items, state } = fold(started(), turnStarted(), proposed(), proposalAnswered("cancel"));
    expect(items[0]?.resolution).toEqual({ kind: "cancelled" });
    expect(state.runtime.phase).toBe("discussing");
  });

  it("building is for good: a later session, exit or proposal doesn't go back", () => {
    const { state } = fold(
      started(),
      turnStarted(),
      proposed(),
      proposalAnswered("build"),
      completed(),
      exited("graceful"),
      started("sess-2"),
      turnStarted(TURN2),
      proposed(REQ1),
      proposalAnswered("change", "smaller", REQ1),
    );
    expect(state.runtime.phase).toBe("building");
  });

  it("a session exit leaves the proposal open, detached, for an answer that resumes it", () => {
    const { state } = fold(started(), turnStarted(), proposed(), exited());
    expect(state.open).toMatchObject([{ kind: "proposal", status: "open", detached: true }]);
  });
});

describe("foldEvent: several requests", () => {
  it("keeps one item per pending request and resolves each on its own", () => {
    const first = fold(started(), turnStarted(), asked(REQ1), permission(REQ2));
    expect(first.state.open.map((i) => i.requestId)).toEqual([REQ1, REQ2]);

    const second = foldEvents([decided(REQ2, "allow")], ENV, first.state);
    expect(second.state.open.map((i) => i.requestId)).toEqual([REQ1]);
    const third = foldEvents([answered(REQ1)], ENV, second.state);
    expect(third.state.open).toEqual([]);
  });

  it("never reopens a request id after it was resolved, as the store does", () => {
    const { state, items } = fold(started(), asked(REQ1), answered(REQ1), asked(REQ1));
    expect(state.open).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("resolved");
  });

  it("ignores a repeated request and a resolution for nothing open", () => {
    const { state, items } = fold(started(), asked(REQ1), asked(REQ1), decided(REQ2), answered(REQ1), answered(REQ1));
    expect(items).toHaveLength(1);
    expect(items[0]?.resolution?.kind).toBe("answered");
    expect(state.open).toEqual([]);
  });
});

describe("foldEvent: sessions and turns", () => {
  it("tracks the session and the open turn", () => {
    let state: FoldState = INITIAL_STATE;
    const step = (event: RuntimeEvent) => {
      state = foldEvent(state, event, ENV).state;
      return state.runtime;
    };
    expect(step(started("sess-9"))).toMatchObject({ live: true, sessionId: "sess-9", turnId: null });
    expect(step(turnStarted())).toMatchObject({ turnId: TURN });
    expect(step(completed(TURN2))).toMatchObject({ turnId: TURN }); // not ours: still open
    expect(step(completed())).toMatchObject({ turnId: null });
    expect(step(exited("graceful"))).toMatchObject({ live: false, sessionId: "sess-9" });
  });

  it("session exit mid-request: closes the turn and detaches the items, which stay open", () => {
    const before = fold(started(), turnStarted(), asked(REQ1), permission(REQ2));
    const after = foldEvent(before.state, exited(), ENV);
    expect(after.state.runtime).toMatchObject({ live: false, turnId: null });
    expect(after.state.open.map((i) => [i.requestId, i.status, i.detached])).toEqual([
      [REQ1, "open", true],
      [REQ2, "open", true],
    ]);
    expect(after.changes.map((c) => c.type)).toEqual(["detached", "detached"]);
    // Nothing dangles: a second exit changes nothing, and a later answer still resolves.
    expect(foldEvent(after.state, exited(), ENV).changes).toEqual([]);
    const resolved = foldEvents([answered(REQ1), decided(REQ2, "deny")], ENV, after.state);
    expect(resolved.state.open).toEqual([]);
    expect(resolved.items.map((i) => i.detached)).toEqual([true, true]);
  });

  it("a resumed session's new ask is a new item beside the detached one", () => {
    const { state } = fold(
      started(),
      turnStarted(),
      asked(REQ1),
      exited(),
      started(),
      turnStarted(TURN2),
      asked(REQ2),
    );
    expect(state.open.map((i) => [i.requestId, i.detached])).toEqual([
      [REQ1, true],
      [REQ2, false],
    ]);
  });
});

describe("foldEvent: archive", () => {
  it("thread.archived dismisses every open item, detached or not", () => {
    const before = fold(started(), turnStarted(), asked(REQ1), exited(), started(), permission(REQ2));
    const archived = ev({ type: "thread.archived", payload: {} });
    const after = foldEvent(before.state, archived, ENV);
    expect(after.state.open).toEqual([]);
    expect(after.state.runtime).toMatchObject({ live: false, turnId: null });
    expect(after.changes.map((c) => [c.item.requestId, c.item.resolution])).toEqual([
      [REQ1, { kind: "dismissed" }],
      [REQ2, { kind: "dismissed" }],
    ]);
  });
});

describe("foldEvent: fingerprints", () => {
  it("carries the request's fingerprint onto the item, and none when it had none", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const { items } = fold(started(), permission(REQ2, { fingerprint }), asked(REQ1));
    expect(items.find((i) => i.requestId === REQ2)?.fingerprint).toBe(fingerprint);
    expect(items.find((i) => i.requestId === REQ1)).not.toHaveProperty("fingerprint");
  });
});

describe("replay", () => {
  it("folding the log in one go equals folding it event by event, as the store does", () => {
    const log = [
      started(),
      turnStarted(),
      said("Looking."),
      asked(REQ1),
      permission(REQ2),
      decided(REQ2, "allow"),
      exited(),
      started("sess-2"),
      turnStarted(TURN2),
      said("Resumed."),
    ];
    const whole = fold(...log);
    let state: FoldState = INITIAL_STATE;
    const items = new Map<string, QueueItem>();
    for (const event of log) {
      const folded = foldEvent(state, event, ENV);
      state = folded.state;
      for (const c of folded.changes) items.set(c.item.id, c.item);
    }
    expect(state).toEqual(whole.state);
    expect([...items.values()]).toEqual(whole.items);
    expect(whole.state.runtime).toMatchObject({ live: true, sessionId: "sess-2", context: "Resumed." });
    expect(whole.state.open.map((i) => [i.requestId, i.detached])).toEqual([[REQ1, true]]);
  });
});

describe("foldEvent: error items", () => {
  const failed = (extra: Record<string, unknown> = {}) =>
    ev({ type: "turn.completed", turnId: TURN, payload: { state: "failed", ...extra } });
  const runtimeError = (message: string, extra: Record<string, unknown> = {}) =>
    ev({ type: "runtime.error", payload: { message }, ...extra });

  it("a failed turn opens a quick-lane error item: what went wrong, Retry suggested", () => {
    const fail = failed({ errorMessage: "API Error: 529 Overloaded" });
    const { state, items } = fold(started(), turnStarted(), said("Looking at the tests."), fail);
    const item = items[0] as QueueItem;
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      id: itemIdFor(errorRequestId(fail.eventId)),
      requestId: errorRequestId(fail.eventId),
      lane: "quick",
      kind: "error",
      turnId: TURN,
      context: "Looking at the tests.",
      ask: "Claude's turn failed",
      suggested: "retry",
      options: [
        { label: "Retry", value: "retry" },
        { label: "Archive", value: "archive" },
      ],
      error: { cause: "turn", message: "API Error: 529 Overloaded", prompts: ["go"] },
      status: "open",
      snoozedUntil: null,
    });
    expect(state.open).toEqual([item]);
    expect(state.runtime.turnId).toBeNull();
  });

  it("takes the agent's runtime error when the failed turn says nothing itself", () => {
    const { items } = fold(
      started(),
      turnStarted(),
      runtimeError("Claude sign-in failed: expired", { turnId: TURN }),
      failed(),
    );
    expect(items.map((i) => i.error?.message)).toEqual(["Claude sign-in failed: expired"]);
  });

  it("a completed or interrupted turn opens nothing", () => {
    const interrupted = ev({ type: "turn.completed", turnId: TURN, payload: { state: "interrupted" } });
    expect(fold(started(), turnStarted(), completed()).items).toEqual([]);
    expect(fold(started(), turnStarted(), interrupted).items).toEqual([]);
  });

  it("a crash mid-turn with nothing asked opens one; with an item open, that item is enough", () => {
    const crash = ev({
      type: "session.exited",
      turnId: TURN,
      payload: { exitKind: "error", reason: "Claude Code process exited with code 1" },
    });
    const { items } = fold(started(), turnStarted(), crash);
    expect(items).toMatchObject([
      {
        kind: "error",
        ask: "Claude stopped mid-turn",
        error: {
          cause: "crash",
          message: "Claude Code process exited with code 1",
          prompts: ["go"],
        },
      },
    ]);
    const asking = fold(started(), turnStarted(), asked(), exited("error"));
    expect(asking.items.map((i) => [i.kind, i.detached])).toEqual([["question", true]]);
  });

  it("no error for a crash or a stop between turns: nothing was cut short", () => {
    expect(fold(started(), turnStarted(), completed(), exited("error")).items).toEqual([]);
    expect(fold(started(), turnStarted(), completed(), exited("graceful")).items).toEqual([]);
  });

  it("no card for a stop Tenzo asked for mid-turn (an archive, its own restart resumes it)", () => {
    expect(fold(started(), turnStarted(), exited("graceful")).items).toEqual([]);
  });

  it("an agent that couldn't start opens one that keeps the prompts that never went", () => {
    const { items } = fold(
      ev({
        type: "runtime.error",
        payload: { message: "Couldn't start claude: not found", unsent: ["Fix it", "And test it"] },
      }),
    );
    expect(items).toMatchObject([
      {
        ask: "Claude couldn't start",
        error: { cause: "start", prompts: ["Fix it", "And test it"] },
      },
    ]);
    expect(items[0]?.turnId).toBeUndefined();
  });

  it("failing to start again updates that one card, with every prompt that never went", () => {
    const cantStart = (unsent: string[]) =>
      ev({ type: "runtime.error", payload: { message: "Couldn't start claude: gone", unsent } });
    const first = foldEvent(INITIAL_STATE, cantStart(["Fix it"]), ENV);
    const again = foldEvent(first.state, cantStart(["And test it"]), ENV);
    expect(again.changes).toMatchObject([
      {
        type: "updated",
        item: {
          id: first.changes[0]?.item.id,
          error: { cause: "start", prompts: ["Fix it", "And test it"] },
        },
      },
    ]);
    expect(again.state.open).toHaveLength(1);
  });

  it("a turn the agent starts by itself leaves the card; only a prompt of ours clears it", () => {
    const own = ev({ type: "turn.started", turnId: TURN2, payload: {} });
    const { state } = fold(started(), turnStarted(), failed(), own);
    expect(state.open.map((i) => i.kind)).toEqual(["error"]);
  });

  it("Retry and Tell it something resolve it; so does the thread's next turn, as recovered", () => {
    const fail = failed();
    const req = errorRequestId(fail.eventId);
    const retried = fold(
      started(),
      turnStarted(),
      fail,
      ev({ type: "error.resolved", requestId: req, payload: { action: "retry" } }),
    );
    expect(retried.state.open).toEqual([]);
    expect(retried.items[0]?.resolution).toEqual({ kind: "retried" });

    const told = fold(
      started(),
      turnStarted(),
      fail,
      ev({ type: "error.resolved", requestId: req, payload: { action: "tell", text: "Use pnpm" } }),
    );
    expect(told.items[0]?.resolution).toEqual({ kind: "told", text: "Use pnpm" });

    const recovered = fold(started(), turnStarted(), fail, turnStarted(TURN2));
    expect(recovered.state.open).toEqual([]);
    expect(recovered.items[0]).toMatchObject({
      status: "resolved",
      resolution: { kind: "recovered" },
    });
    expect(recovered.state.runtime).toMatchObject({ turnId: TURN2, prompt: "go", error: null });
  });

  it("remembers the turn's prompt and error; a new turn starts clean", () => {
    const { state } = fold(started(), turnStarted(), runtimeError("boom", { turnId: TURN }));
    expect(state.runtime).toMatchObject({ prompt: "go", error: "boom" });
    const agentTurn = ev({ type: "turn.started", turnId: TURN2, payload: {} });
    expect(fold(started(), turnStarted(), completed(), agentTurn).state.runtime).toMatchObject({
      prompt: null,
      error: null,
    });
  });

  it("cuts a long message; archive dismisses the error like any item", () => {
    const { items } = fold(started(), turnStarted(), failed({ errorMessage: "x".repeat(5000) }));
    expect(items[0]?.error?.message.length).toBe(ERROR_LIMIT);
    const archived = fold(
      started(),
      turnStarted(),
      failed(),
      ev({ type: "thread.archived", payload: {} }),
    );
    expect(archived.items[0]?.resolution).toEqual({ kind: "dismissed" });
  });

  it("the same log gives the same error item, id included", () => {
    const log = [started(), turnStarted(), failed({ errorMessage: "no" })];
    expect(fold(...log).items).toEqual(fold(...log).items);
  });
});

describe("foldEvent: snooze", () => {
  const until = "2026-10-02T12:15:00.000Z";
  const snoozed = (requestId = REQ1) =>
    ev({ type: "item.snoozed", requestId, payload: { until } });
  const unsnoozed = (requestId = REQ1, reason = "returned") =>
    ev({ type: "item.unsnoozed", requestId, payload: { reason } });

  it("snoozing sets the item's return time, and waking clears it; it stays open", () => {
    const first = fold(started(), turnStarted(), asked(), snoozed());
    expect(first.state.open).toMatchObject([{ requestId: REQ1, snoozedUntil: until }]);
    const folded = foldEvent(first.state, unsnoozed(REQ1, "undo"), ENV);
    expect(folded.changes).toMatchObject([
      { type: "unsnoozed", item: { requestId: REQ1, snoozedUntil: null, status: "open" } },
    ]);
    expect(folded.state.open[0]?.snoozedUntil).toBeNull();
  });

  it("reports the change, and nothing for an item that isn't open or is already so", () => {
    const { state } = fold(started(), turnStarted(), asked());
    const change = foldEvent(state, snoozed(), ENV);
    expect(change.changes.map((c) => c.type)).toEqual(["snoozed"]);
    expect(foldEvent(change.state, snoozed(), ENV).changes).toEqual([]);
    expect(foldEvent(state, unsnoozed(), ENV).changes).toEqual([]);
    expect(foldEvent(state, snoozed(REQ2), ENV).changes).toEqual([]);
    const answeredState = fold(started(), turnStarted(), asked(), answered()).state;
    expect(foldEvent(answeredState, snoozed(), ENV)).toEqual({ state: answeredState, changes: [] });
  });

  it("a snoozed item answered or archived resolves as usual", () => {
    const { items } = fold(started(), turnStarted(), asked(), snoozed(), answered());
    expect(items[0]).toMatchObject({ status: "resolved", snoozedUntil: until });
  });
});

describe("trimContext", () => {
  it("keeps the last paragraphs that fit, whitespace folded", () => {
    expect(trimContext("  one\n two  \n\n three ")).toBe("one two\nthree");
    const long = `${"word ".repeat(100)}\n\nThe last bit.`;
    expect(trimContext(long)).toBe("The last bit.");
  });

  it("cuts one long paragraph from the start, at a word", () => {
    const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const trimmed = trimContext(text);
    expect(trimmed.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
    expect(trimmed.startsWith("…w")).toBe(true);
    expect(trimmed.endsWith("w99")).toBe(true);
  });
});

describe("foldEvent: finished work", () => {
  const shot = (n: number) => ({
    id: `att_${String(n).repeat(20)}`,
    file: `att_${String(n).repeat(20)}.png`,
    name: `shot${n}.png`,
    mediaType: "image/png",
    bytes: 100,
  });
  const attached = (n: number) =>
    ev({ type: "attachment.added", turnId: TURN, payload: { attachment: shot(n) } });
  const exposed = (port = 5173, path = "") =>
    ev({ type: "preview.exposed", turnId: TURN, payload: { port, path } });
  const reported = (requestId = REQ1, extra: Record<string, unknown> = {}) =>
    ev({
      type: "report.submitted",
      turnId: TURN,
      requestId,
      payload: {
        summary: "Added the counter.",
        howToTest: "Tap it.",
        checks: [{ name: "Tests", status: "pass" }],
        ...extra,
      },
    });
  const done = (requestId = REQ1) =>
    ev({ type: "report.resolved", requestId, payload: { decision: "done" } });

  it("report opens a review-lane item with what was attached and exposed; the thread is in review", () => {
    const { items, state } = fold(
      started(),
      turnStarted(),
      proposed(REQ3),
      proposalAnswered("build", undefined, REQ3),
      attached(1),
      exposed(5173, "counter"),
      attached(2),
      said("All done."),
      reported(REQ1, { headline: "Counter works" }),
    );
    const item = items.find((i) => i.kind === "finished");
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      lane: "review",
      ask: "Counter works",
      context: "All done.",
      options: [{ label: "Done", value: "done", recommended: true }],
      suggested: "done",
      finished: {
        headline: "Counter works",
        summary: "Added the counter.",
        howToTest: "Tap it.",
        checks: [{ name: "Tests", status: "pass" }],
        attachments: [shot(1), shot(2)],
        live: { port: 5173, path: "counter" },
      },
    });
    expect(state.runtime).toMatchObject({
      phase: "review",
      attachments: [],
      preview: { port: 5173, path: "counter" },
    });
  });

  it("a report before Build it doesn't skip the proposal: the thread keeps discussing", () => {
    const { state } = fold(started(), turnStarted(), reported());
    expect(state.runtime.phase).toBe("discussing");
  });

  it("without a headline, the ask says it's ready for review (the card shows the thread's title)", () => {
    const { items } = fold(started(), turnStarted(), reported());
    expect(items[0]?.ask).toBe("Ready for review");
    expect(items[0]?.finished?.headline).toBeUndefined();
    expect(items[0]?.finished?.live).toBeNull();
  });

  it("Done resolves it; a session exit never detaches it: nothing waits on a report", () => {
    const exitedAfter = fold(started(), turnStarted(), reported(), completed(), exited("graceful"));
    expect(exitedAfter.state.open).toMatchObject([{ kind: "finished", detached: false }]);
    expect(exitedAfter.items).toHaveLength(1);
    const { items, state } = fold(started(), turnStarted(), reported(), exited(), done());
    expect(state.open).toEqual([]);
    expect(items[0]?.resolution).toEqual({ kind: "done" });
  });

  it("a newer report replaces the one waiting: one finished card per thread", () => {
    const { items, state } = fold(
      started(),
      turnStarted(),
      attached(1),
      reported(REQ1),
      attached(2),
      reported(REQ2),
    );
    expect(items.map((i) => [i.requestId, i.status, i.resolution?.kind ?? null])).toEqual([
      [REQ1, "resolved", "superseded"],
      [REQ2, "open", null],
    ]);
    expect(state.open.map((i) => i.requestId)).toEqual([REQ2]);
    // Each report carries what was attached since the one before.
    expect(items.map((i) => i.finished?.attachments.map((a) => a.name))).toEqual([
      ["shot1.png"],
      ["shot2.png"],
    ]);
  });

  it("archiving dismisses it and forgets the live app", () => {
    const { items, state } = fold(
      started(),
      exposed(),
      reported(),
      ev({ type: "thread.archived", payload: {} }),
    );
    expect(items[0]?.resolution).toEqual({ kind: "dismissed" });
    expect(state.runtime.preview).toBeNull();
  });

  it("replays to the same state", () => {
    const log = [started(), turnStarted(), attached(1), exposed(), reported(), done(), attached(2)];
    const whole = fold(...log);
    let state: FoldState = INITIAL_STATE;
    for (const event of log) state = foldEvent(state, event, ENV).state;
    expect(state).toEqual(whole.state);
    expect(state.runtime.attachments.map((a) => a.name)).toEqual(["shot2.png"]);
  });
});
