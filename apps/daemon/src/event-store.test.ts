import { join } from "node:path";
import type { RequestId, RuntimeEvent, ThreadId, TurnId } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  clearPrompts,
  countEventsAfter,
  enqueuePrompt,
  eventPage,
  getItem,
  hasLanded,
  lastSeq,
  liveThreads,
  loadFoldState,
  nextPrompt,
  openItems,
  queuedCount,
  removePrompt,
  threadEvents,
  threadsWithPrompts,
} from "./event-store.ts";
import { foldEvents } from "./fold.ts";
import { addProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, removeTempDirs, tempDir } from "./testing.ts";
import { archiveThread, createThread } from "./threads.ts";

afterAll(removeTempDirs);

let home: string;
let store: Store;
let threadId: ThreadId;
const TURN = "11111111-1111-4111-8111-111111111111" as TurnId;
const REQ1 = "req_aaaaaaaaaaaaaaaaaaaa" as RequestId;
const REQ2 = "req_bbbbbbbbbbbbbbbbbbbb" as RequestId;

beforeEach(async () => {
  home = join(tempDir("home"), ".tenzo");
  store = openStore(home);
  await addProject(store, initRepo("app"));
  threadId = (await createThread(store, "app", "Work")).id;
});
afterEach(() => store.close());

let n = 0;
function ev(event: Record<string, unknown>): RuntimeEvent {
  n++;
  return {
    eventId: `evt_${String(n).padStart(20, "0")}`,
    threadId,
    agent: "claude",
    createdAt: new Date(Date.UTC(2026, 9, 2, 12, 0, 0, n)).toISOString(),
    ...event,
  } as RuntimeEvent;
}
const question = {
  id: "Q?",
  header: "",
  question: "Q?",
  options: [{ label: "A", value: "A", description: "", recommended: true }],
  multiSelect: false,
};

const log = () => [
  ev({ type: "session.started", payload: { sessionId: "sess-1", resumed: false } }),
  ev({ type: "turn.started", turnId: TURN, payload: { prompt: "go" } }),
  ev({
    type: "item.completed",
    turnId: TURN,
    itemId: "m1",
    payload: { itemType: "assistant_message", status: "completed", text: "Thinking it over." },
  }),
  ev({ type: "user-input.requested", turnId: TURN, requestId: REQ1, payload: { questions: [question] } }),
  ev({
    type: "request.opened",
    turnId: TURN,
    requestId: REQ2,
    payload: { toolKind: "command", toolName: "Bash", detail: "Bash: ls", input: { command: "ls" } },
  }),
  ev({ type: "request.resolved", turnId: TURN, requestId: REQ2, payload: { decision: "allow" } }),
];

describe("event store", () => {
  it("appends in order, every row stamped with the environment id", () => {
    const events = log();
    const seqs = events.map((e) => appendEvent(store, e).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const stored = threadEvents(store, threadId);
    expect(stored.map((s) => s.event)).toEqual(events);
    expect(stored.every((s) => s.environmentId === store.environmentId)).toBe(true);
    expect(threadEvents(store, threadId, seqs[3]).map((s) => s.event)).toEqual(events.slice(4));
    expect(lastSeq(store, threadId)).toBe(seqs.at(-1));
    const rows = store.db.prepare("SELECT DISTINCT environment_id FROM items").all();
    expect(rows).toEqual([{ environment_id: store.environmentId }]);
  });

  it("pages a thread's events: the latest first, then earlier ones before a seq", async () => {
    const other = (await createThread(store, "app", "Other")).id;
    const events = log();
    const seqs: number[] = [];
    for (const e of events) {
      seqs.push(appendEvent(store, e).seq);
      // Another thread's events interleave: pages and counts never see them.
      appendEvent(store, { ...ev({ type: "thread.archived", payload: {} }), threadId: other });
    }
    const latest = eventPage(store, threadId, { limit: 4 });
    expect(latest.events.map((s) => s.seq)).toEqual(seqs.slice(2));
    expect(latest.older).toBe(true);
    const earlier = eventPage(store, threadId, { before: seqs[2] ?? 0, limit: 4 });
    expect(earlier.events.map((s) => s.seq)).toEqual(seqs.slice(0, 2));
    expect(earlier.older).toBe(false);
    expect(eventPage(store, threadId, { after: seqs[1] ?? 0, before: seqs[4] ?? 0, limit: 9 }).events.map((s) => s.seq)).toEqual(
      seqs.slice(2, 4),
    );
    expect(countEventsAfter(store, threadId, seqs[3] ?? 0)).toBe(2);
    expect(countEventsAfter(store, threadId, 0)).toBe(6);
  });

  it("stores the projection with each event; reopening gives the same as folding the log", () => {
    for (const e of log()) appendEvent(store, e);
    store.close();
    store = openStore(home); // a restarted daemon

    const stored = loadFoldState(store, threadId);
    const replayed = foldEvents(
      threadEvents(store, threadId).map((s) => s.event),
      store.environmentId,
    );
    expect(stored).toEqual(replayed.state);
    for (const item of replayed.items) expect(getItem(store, item.id)).toEqual(item);
    expect(stored.runtime).toMatchObject({ live: true, sessionId: "sess-1", turnId: TURN });
    expect(openItems(store).map((i) => i.requestId)).toEqual([REQ1]);
    expect(liveThreads(store)).toEqual([threadId]);
  });

  it("session.exited detaches the open items and keeps them on the queue", () => {
    for (const e of log()) appendEvent(store, e);
    const { changes } = appendEvent(
      store,
      ev({ type: "session.exited", payload: { exitKind: "error" } }),
    );
    expect(changes.map((c) => [c.type, c.item.requestId])).toEqual([["detached", REQ1]]);
    expect(openItems(store)).toMatchObject([{ requestId: REQ1, detached: true }]);
    expect(liveThreads(store)).toEqual([]);
  });

  it("refuses an event for a thread it doesn't know, writing nothing", () => {
    expect(() => appendEvent(store, { ...log()[0], threadId: "thr_zzzzzzzzzzzzzzzzzzzz" } as RuntimeEvent)).toThrow();
    expect(threadEvents(store, threadId)).toEqual([]);
  });

  it("thread.archived dismisses the open items; replaying the log gives the same, archive included", () => {
    for (const e of log()) appendEvent(store, e);
    appendEvent(store, ev({ type: "session.exited", payload: { exitKind: "graceful" } }));
    const { changes } = appendEvent(store, ev({ type: "thread.archived", payload: {} }));
    expect(changes.map((c) => [c.type, c.item.requestId, c.item.resolution])).toEqual([
      ["resolved", REQ1, { kind: "dismissed" }],
    ]);
    const replayed = foldEvents(
      threadEvents(store, threadId).map((s) => s.event),
      store.environmentId,
    );
    expect(loadFoldState(store, threadId)).toEqual(replayed.state);
    expect(replayed.state.open).toEqual([]);
    for (const item of replayed.items) expect(getItem(store, item.id)).toEqual(item);
  });

  it("never reopens a resolved item when its request shows up again", () => {
    const events = log();
    for (const e of events) appendEvent(store, e);
    const again = { ...events[4], eventId: "evt_zzzzzzzzzzzzzzzzzzzz" } as RuntimeEvent; // REQ2, resolved
    expect(appendEvent(store, again).changes).toEqual([]);
    expect(getItem(store, `itm_${REQ2.slice(4)}`)?.status).toBe("resolved");
  });

  it("hides an archived thread's open items from the queue", async () => {
    for (const e of log()) appendEvent(store, e);
    await archiveThread(store, threadId);
    expect(openItems(store)).toEqual([]);
  });

  it("counts a thread landed only while its latest turn is the one that landed it", () => {
    const LATER = "22222222-2222-4222-8222-222222222222" as TurnId;
    const landed = ev({ type: "thread.landed", turnId: TURN, payload: { url: "https://example.invalid/pr/1" } });
    appendEvent(store, ev({ type: "turn.started", turnId: TURN, payload: { prompt: "land it" } }));
    expect(hasLanded(store, threadId)).toBe(false);
    appendEvent(store, landed);
    appendEvent(store, ev({ type: "turn.completed", turnId: TURN, payload: { state: "completed" } }));
    expect(hasLanded(store, threadId)).toBe(true);
    // It carried on with more work after landing: no longer what it stands for.
    appendEvent(store, ev({ type: "turn.started", turnId: LATER, payload: { prompt: "one more thing" } }));
    expect(hasLanded(store, threadId)).toBe(false);
  });
});

describe("prompt queue", () => {
  it("keeps prompts per thread, oldest first, across a reopen", () => {
    enqueuePrompt(store, threadId, "one");
    enqueuePrompt(store, threadId, "two", { kind: "permission", fingerprint: `sha256:${"0".repeat(64)}`, decision: "allow" });
    store.close();
    store = openStore(home);
    expect(queuedCount(store, threadId)).toBe(2);
    expect(threadsWithPrompts(store)).toEqual([threadId]);
    const first = nextPrompt(store, threadId);
    expect(first).toMatchObject({ text: "one", reply: null });
    removePrompt(store, first?.seq ?? 0);
    expect(nextPrompt(store, threadId)).toMatchObject({
      text: "two",
      reply: { kind: "permission", decision: "allow" },
    });
    clearPrompts(store, threadId);
    expect(nextPrompt(store, threadId)).toBeUndefined();
  });
});
