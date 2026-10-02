import { join } from "node:path";
import { QueueItem, StoredEvent, ThreadView, type UserInputQuestion } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeSession } from "./agent/fake-agent.ts";
import { Engine, type EngineChange } from "./engine.ts";
import { addProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, removeTempDirs, tempDir } from "./testing.ts";
import { getThread } from "./threads.ts";

afterAll(removeTempDirs);

const color: UserInputQuestion = {
  id: "Which color?",
  header: "Color",
  question: "Which color?",
  options: [
    { label: "Red", value: "Red", description: "", recommended: false },
    { label: "Blue", value: "Blue (Recommended)", description: "", recommended: true },
  ],
  multiSelect: false,
};
const blue = { kind: "question", answers: { "Which color?": "Blue (Recommended)" } } as const;

let home: string;
let stores: Store[];
let engines: Engine[];

beforeEach(async () => {
  home = join(tempDir("home"), ".tenzo");
  stores = [];
  engines = [];
  const store = openStore(home);
  await addProject(store, initRepo("app"));
  store.close();
});
afterEach(async () => {
  for (const engine of engines) await engine.close();
  for (const store of stores) store.close();
});

/** A daemon's engine on `home`, as `tenzo serve` makes it. */
function daemon(adapter = new FakeAdapter()) {
  const store = openStore(home);
  stores.push(store);
  const engine = new Engine({ store, adapters: { claude: adapter }, log: () => {} });
  engines.push(engine);
  const changes: EngineChange[] = [];
  engine.subscribe((change) => changes.push(change));
  engine.start();
  return { engine, adapter, store, changes };
}

/** "kill -9": the engine and its sessions vanish without a word. */
function kill(d: ReturnType<typeof daemon>) {
  engines.splice(engines.indexOf(d.engine), 1);
  stores.splice(stores.indexOf(d.store), 1);
  d.store.close();
}

/** Lets the engine read what the fake sessions emitted. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Starts a thread whose agent, on the prompt, says something and asks the color. */
async function threadAsking(d: ReturnType<typeof daemon>) {
  d.adapter.onStart = (session) => {
    session.onPrompt = () => {
      session.say("I looked around.\n\nOne thing decides the design.");
      session.ask([color]);
    };
  };
  const thread = await d.engine.createThread({ project: "app", prompt: "Paint it", model: "haiku" });
  await settle();
  return thread;
}

describe("Engine: running threads", () => {
  it("starts the agent in the thread's worktree with its model, sends the prompt, logs every event", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", prompt: "Hello there", model: "haiku" });
    expect(ThreadView.parse(thread)).toEqual(thread);
    expect(thread).toMatchObject({ title: "Hello there", activity: "working", projectName: "app" });
    const session = d.adapter.last;
    expect(session.input).toMatchObject({ cwd: thread.worktreePath, model: "haiku" });
    expect(session.input.resumeSessionId).toBeUndefined();
    expect(session.prompts).toEqual(["Hello there"]);

    session.say("Hi.");
    session.complete();
    await settle();
    const { events, thread: after } = d.engine.events(thread.id);
    for (const e of events) expect(StoredEvent.parse(e)).toEqual(e);
    expect(events.map((e) => e.event.type)).toEqual([
      "session.started",
      "turn.started",
      "item.completed",
      "turn.completed",
    ]);
    expect(events.every((e) => e.environmentId === d.store.environmentId)).toBe(true);
    expect(after).toMatchObject({ activity: "idle", working: false, lastSeq: events.at(-1)?.seq });
    expect(getThread(d.store, thread.id).sessionId).toBe(session.sessionId);
    // The session stays up after the turn: background work may still report.
    expect(session.stopped).toBe(false);
    session.say("A background task finished.");
    await settle();
    expect(d.engine.events(thread.id, after.lastSeq).events).toHaveLength(1);
  });

  it("a thread without a prompt starts no agent", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", title: "Later" });
    expect(d.adapter.sessions).toEqual([]);
    expect(thread.activity).toBe("idle");
    await expect(d.engine.createThread({ project: "app" })).rejects.toThrow(/title or a prompt/);
  });

  it("queues a prompt sent mid-turn and sends it when the turn ends", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", prompt: "first" });
    const session = d.adapter.last;
    const queued = d.engine.send(thread.id, "second");
    expect(queued).toMatchObject({ queued: 1, working: true });
    d.engine.send(thread.id, "third");
    expect(session.prompts).toEqual(["first"]);

    session.complete();
    await settle();
    expect(session.prompts).toEqual(["first", "second"]);
    session.complete();
    await settle();
    expect(session.prompts).toEqual(["first", "second", "third"]);
    expect(d.engine.view(thread.id).queued).toBe(0);
    expect(d.adapter.sessions).toHaveLength(1);
  });

  it("a prompt doesn't wait for a turn the agent started by itself", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", prompt: "first" });
    const session = d.adapter.last;
    session.complete();
    await settle();
    session.emit({ type: "turn.started", turnId: "33333333-3333-4333-8333-333333333333", payload: {} });
    await settle();
    // The fake refuses a second turn like Claude would refuse ours; the engine only waits for its own.
    session.turnId = null;
    d.engine.send(thread.id, "now");
    expect(session.prompts).toEqual(["first", "now"]);
  });

  it("resumes the stored session for a prompt after the agent exited", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", prompt: "first", model: "haiku" });
    const first = d.adapter.last;
    first.complete();
    first.crash();
    await settle();
    expect(d.engine.view(thread.id).activity).toBe("idle");
    d.engine.send(thread.id, "again");
    const second = d.adapter.last;
    expect(second).not.toBe(first);
    expect(second.input).toMatchObject({ resumeSessionId: first.sessionId, model: "haiku" });
    expect(second.prompts).toEqual(["again"]);
  });

  it("records a failure to start the agent and drops the prompts it couldn't send", async () => {
    const adapter = new FakeAdapter();
    adapter.failWith = new Error("claude not found");
    const d = daemon(adapter);
    const thread = await d.engine.createThread({ project: "app", prompt: "hi" });
    const { events } = d.engine.events(thread.id);
    expect(events.map((e) => e.event.type)).toEqual(["runtime.error"]);
    expect(JSON.stringify(events[0]?.event)).toMatch(/Couldn't start claude: claude not found/);
    expect(d.engine.view(thread.id)).toMatchObject({ queued: 0, activity: "idle" });
  });
});

describe("Engine: items", () => {
  it("a question becomes an item; answering it reaches the agent and takes it off the queue", async () => {
    const d = daemon();
    const thread = await threadAsking(d);
    const { items } = d.engine.snapshot();
    expect(items).toHaveLength(1);
    const item = items[0] as QueueItem;
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      threadId: thread.id,
      lane: "quick",
      kind: "question",
      context: "I looked around.\nOne thing decides the design.",
      ask: "Which color?",
      suggested: "Blue (Recommended)",
      detached: false,
    });
    expect(d.engine.view(thread.id).activity).toBe("needs-you");
    expect(d.changes.some((c) => c.type === "item" && c.change.type === "opened")).toBe(true);

    const result = await d.engine.answer(item.id, blue);
    expect(result.delivery).toBe("live");
    expect(result.item).toMatchObject({
      status: "resolved",
      resolution: { kind: "answered", answers: blue.answers },
    });
    expect(d.adapter.last.answered).toEqual([{ requestId: item.requestId, answers: blue.answers }]);
    expect(d.engine.snapshot().items).toEqual([]);
    expect(d.adapter.sessions).toHaveLength(1);
    await expect(d.engine.answer(item.id, blue)).rejects.toThrow(/no longer open \(answered\)/);
  });

  it("a permission request becomes an Allow/Deny item; deny sends the reason", async () => {
    const d = daemon();
    d.adapter.onStart = (s) => {
      s.onPrompt = () => s.askPermission("Bash", { command: "rm -rf build" });
    };
    await d.engine.createThread({ project: "app", prompt: "clean" });
    await settle();
    const [item] = d.engine.snapshot().items;
    expect(item).toMatchObject({ kind: "permission", ask: "Allow Bash: rm -rf build?", suggested: "allow" });
    await expect(d.engine.answer(item?.id ?? "", blue)).rejects.toThrow(/allow or deny/);
    const result = await d.engine.answer(item?.id ?? "", {
      kind: "permission",
      decision: "deny",
      message: "use git clean",
    });
    expect(result.item.resolution).toEqual({ kind: "denied", message: "use git clean" });
    expect(d.adapter.last.answered[0]).toMatchObject({ decision: "deny", message: "use git clean" });
  });

  it("keeps one item per pending request when several are open at once", async () => {
    const d = daemon();
    let session!: FakeSession;
    d.adapter.onStart = (s) => {
      session = s;
      s.onPrompt = () => {
        s.ask([color]);
        s.askPermission("Bash", { command: "make" });
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "go" });
    await settle();
    const items = d.engine.snapshot().items;
    expect(items.map((i) => i.kind)).toEqual(["question", "permission"]);
    await d.engine.answer(items[1]?.id ?? "", { kind: "permission", decision: "allow" });
    expect(d.engine.snapshot().items.map((i) => i.id)).toEqual([items[0]?.id]);
    expect(d.engine.view(thread.id).openItems).toBe(1);
    await d.engine.answer(items[0]?.id ?? "", blue);
    expect(d.engine.snapshot().items).toEqual([]);
    expect(session.answered).toHaveLength(2);
  });

  it("an interrupt cancels the items", async () => {
    const d = daemon();
    await threadAsking(d);
    await d.adapter.last.interrupt();
    await settle();
    expect(d.engine.snapshot().items).toEqual([]);
  });

  it("refuses answers to unknown items and incomplete answers", async () => {
    const d = daemon();
    await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    await expect(d.engine.answer("itm_nope", blue)).rejects.toThrow(/No item "itm_nope"/);
    await expect(
      d.engine.answer(item?.id ?? "", { kind: "question", answers: { "Which color?": " " } }),
    ).rejects.toThrow(/needs an answer/);
    expect(d.engine.snapshot().items).toHaveLength(1);
  });
});

describe("Engine: when the agent that asked is gone", () => {
  it("session exit mid-question: the item stays, detached; answering resumes the session with the answer", async () => {
    const d = daemon();
    const thread = await threadAsking(d);
    const first = d.adapter.last;
    first.crash("API error");
    await settle();
    const [item] = d.engine.snapshot().items;
    expect(item).toMatchObject({ status: "open", detached: true });
    expect(d.engine.view(thread.id)).toMatchObject({ activity: "needs-you", working: false });

    const result = await d.engine.answer(item?.id ?? "", blue);
    expect(result.delivery).toBe("message");
    expect(result.item).toMatchObject({ status: "resolved", resolution: { kind: "answered" } });
    expect(d.engine.snapshot().items).toEqual([]);
    const second = d.adapter.last;
    expect(second).not.toBe(first);
    expect(second.input.resumeSessionId).toBe(first.sessionId);
    expect(second.prompts).toHaveLength(1);
    expect(second.prompts[0]).toContain("You asked: Which color?\nMy answer: Blue");
  });

  it("answers for you when the resumed agent asks the same again, once", async () => {
    const d = daemon();
    await threadAsking(d);
    d.adapter.last.crash();
    await settle();
    d.adapter.onStart = (s) => {
      s.onPrompt = () => {
        s.ask([color]); // the same question again: answered from what you chose
      };
    };
    const [item] = d.engine.snapshot().items;
    await d.engine.answer(item?.id ?? "", blue);
    await settle();
    const resumed = d.adapter.last;
    expect(resumed.answered).toEqual([{ requestId: expect.any(String), answers: blue.answers }]);
    expect(d.engine.snapshot().items).toEqual([]);
    // Only for that turn: a later ask is yours again (the fake asks on every prompt).
    resumed.complete();
    await settle();
    d.engine.send(item?.threadId ?? "", "next");
    await settle();
    expect(d.engine.snapshot().items).toHaveLength(1);
  });

  it("a permission answered after the agent stopped tells it whether to go ahead, and allows the re-run", async () => {
    const d = daemon();
    d.adapter.onStart = (s) => {
      s.onPrompt = () => s.askPermission("Bash", { command: "rm -rf build" });
    };
    await d.engine.createThread({ project: "app", prompt: "clean" });
    await settle();
    d.adapter.last.crash();
    await settle();
    const [item] = d.engine.snapshot().items;
    const result = await d.engine.answer(item?.id ?? "", { kind: "permission", decision: "allow" });
    expect(result.delivery).toBe("message");
    await settle();
    const resumed = d.adapter.last;
    expect(resumed.prompts[0]).toMatch(/permission for this: Bash: rm -rf build\nI allow it/);
    expect(resumed.answered).toEqual([{ requestId: expect.any(String), decision: "allow" }]);
    expect(d.engine.snapshot().items).toEqual([]);
  });
});

describe("Engine: restarts", () => {
  it("open items survive a kill; the next daemon detaches them and an answer resumes the agent", async () => {
    const first = daemon();
    const thread = await threadAsking(first);
    const [before] = first.engine.snapshot().items;
    const sessionId = first.adapter.last.sessionId;
    kill(first);

    const second = daemon();
    const { items, threads } = second.engine.snapshot();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: before?.id, status: "open", detached: true });
    expect(threads.map((t) => [t.id, t.activity])).toEqual([[thread.id, "needs-you"]]);
    const types = second.engine.events(thread.id).events.map((e) => e.event.type);
    expect(types.at(-1)).toBe("session.exited");
    expect(second.adapter.sessions).toEqual([]); // nothing runs until there is something to send

    await second.engine.answer(items[0]?.id ?? "", blue);
    const resumed = second.adapter.last;
    expect(resumed.input).toMatchObject({ resumeSessionId: sessionId, model: "haiku" });
    expect(resumed.prompts[0]).toContain("My answer: Blue");
    resumed.say("Blue it is.");
    resumed.complete();
    await settle();
    expect(second.engine.view(thread.id).activity).toBe("idle");
  });

  it("a graceful stop leaves open items for the next daemon too", async () => {
    const first = daemon();
    await threadAsking(first);
    await first.engine.close();
    expect(first.adapter.last.stopped).toBe(true);
    const second = daemon();
    expect(second.engine.snapshot().items).toMatchObject([{ status: "open", detached: true }]);
  });

  it("prompts still queued at a kill are sent by the next daemon", async () => {
    const first = daemon();
    const thread = await first.engine.createThread({ project: "app", prompt: "first" });
    first.engine.send(thread.id, "second");
    kill(first);
    const second = daemon();
    expect(second.adapter.last.prompts).toEqual(["second"]);
    expect(second.adapter.last.input.resumeSessionId).toBe(first.adapter.last.sessionId);
  });
});

describe("Engine: archive", () => {
  it("stops the agent, dismisses its items and drops its queued prompts", async () => {
    const d = daemon();
    const thread = await threadAsking(d);
    d.engine.send(thread.id, "later");
    const archived = await d.engine.archive(thread.id);
    expect(archived).toMatchObject({ status: "archived", activity: "idle", queued: 0 });
    expect(d.adapter.last.stopped).toBe(true);
    expect(d.engine.snapshot()).toMatchObject({ items: [], threads: [] });
    const dismissed = d.changes.filter((c) => c.type === "item" && c.change.type === "resolved");
    expect(dismissed.at(-1)).toMatchObject({ change: { item: { resolution: { kind: "dismissed" } } } });
    expect(() => d.engine.send(thread.id, "x")).toThrow(/archived/);
  });
});
