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
