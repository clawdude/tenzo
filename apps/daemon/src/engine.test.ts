import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueueItem, StoredEvent, ThreadView, type UserInputQuestion } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeSession } from "./agent/fake-agent.ts";
import { Engine, type EngineChange, type EngineOptions } from "./engine.ts";
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
function daemon(
  adapter = new FakeAdapter(),
  options: Pick<EngineOptions, "titler" | "defaultModel" | "prompts"> = {},
) {
  const store = openStore(home);
  stores.push(store);
  const engine = new Engine({ store, adapters: { claude: adapter }, log: () => {}, ...options });
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
    expect(d.engine.events(thread.id, { after: after.lastSeq }).events).toHaveLength(1);
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

  it("runs threads started without a model on the default model, if there is one", async () => {
    const d = daemon(new FakeAdapter(), { defaultModel: "haiku" });
    await d.engine.createThread({ project: "app", prompt: "cheap" });
    expect(d.adapter.last.input.model).toBe("haiku");
    await d.engine.createThread({ project: "app", prompt: "dear", model: "opus" });
    expect(d.adapter.last.input.model).toBe("opus");
    const plain = daemon();
    await plain.engine.createThread({ project: "app", prompt: "default" });
    expect(plain.adapter.last.input.model).toBeUndefined();
  });

  it("says when each thread was last active", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", title: "Quiet" });
    expect(thread.activeAt).toBe(thread.createdAt);
    const busy = await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    const { events } = d.engine.events(busy.id);
    expect(d.engine.view(busy.id).activeAt).toBe(events.at(-1)?.event.createdAt);
  });
});

describe("Engine: names and projects", () => {
  /** A titler the test answers by hand. */
  function fakeTitler() {
    const calls: { prompt: string; signal: AbortSignal; answer: (title: string | null) => void }[] =
      [];
    const titler = (prompt: string, signal: AbortSignal) =>
      new Promise<string | null>((resolve) => calls.push({ prompt, signal, answer: resolve }));
    return { titler, calls };
  }

  it("starts a thread under the prompt's first words, then renames it and says so", async () => {
    const { titler, calls } = fakeTitler();
    const d = daemon(new FakeAdapter(), { titler });
    const prompt = "Ask me whether to greet in English or Italian, then write greeting.txt";
    const thread = await d.engine.createThread({ project: "app", prompt });
    // The thread is running before any name exists: nothing waits for it.
    expect(thread.title).toBe("Ask me whether to…");
    expect(d.adapter.last.prompts).toEqual([prompt]);
    expect(calls.map((c) => c.prompt)).toEqual([prompt]);

    d.changes.length = 0;
    calls[0]?.answer("Greeting language");
    await settle();
    expect(d.engine.view(thread.id).title).toBe("Greeting language");
    expect(d.changes).toContainEqual({
      type: "thread",
      thread: expect.objectContaining({ id: thread.id, title: "Greeting language" }),
    });
    expect(getThread(d.store, thread.id).branch).toBe(thread.branch); // the branch keeps its name
  });

  it("keeps the stand-in, quietly, when no name comes back", async () => {
    const titles = [null, new Error("no claude")];
    const d = daemon(new FakeAdapter(), {
      titler: async () => {
        const next = titles.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
    });
    const a = await d.engine.createThread({ project: "app", prompt: "Fix the flaky checkout test" });
    const b = await d.engine.createThread({ project: "app", prompt: "Rename the session store" });
    await settle();
    expect(d.engine.view(a.id).title).toBe("Fix the flaky checkout…");
    expect(d.engine.view(b.id).title).toBe("Rename the session store");
  });

  it("never renames a thread given a title, or one without a prompt", async () => {
    const { titler, calls } = fakeTitler();
    const d = daemon(new FakeAdapter(), { titler });
    await d.engine.createThread({ project: "app", title: "Mine", prompt: "Do the thing" });
    await d.engine.createThread({ project: "app", title: "Later" });
    expect(calls).toEqual([]);
  });

  it("stops thinking of names on close, and drops a late one", async () => {
    const { titler, calls } = fakeTitler();
    const d = daemon(new FakeAdapter(), { titler });
    const thread = await d.engine.createThread({ project: "app", prompt: "Something long" });
    const call = calls[0];
    if (!call) throw new Error("the titler wasn't asked");
    call.signal.addEventListener("abort", () => call.answer("Too late"));
    engines.splice(engines.indexOf(d.engine), 1);
    await d.engine.close();
    expect(call.signal.aborted).toBe(true);
    expect(getThread(d.store, thread.id).title).toBe("Something long");
  });

  it("names on startup a stand-in the last daemon stopped naming, gracefully or killed", async () => {
    // Thinks until stopped, then has nothing (as the Claude titler does when aborted).
    const slow = (_prompt: string, signal: AbortSignal) =>
      new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null)));
    const d1 = daemon(new FakeAdapter(), { titler: slow });
    const closed = await d1.engine.createThread({ project: "app", prompt: "Make the login page faster" });
    engines.splice(engines.indexOf(d1.engine), 1);
    await d1.engine.close(); // mid-naming
    const d2 = daemon(new FakeAdapter(), { titler: slow });
    const killed = await d2.engine.createThread({ project: "app", prompt: "Drop the legacy exporter" });
    kill(d2); // mid-naming, without a word

    const { titler, calls } = fakeTitler();
    const d3 = daemon(new FakeAdapter(), { titler });
    expect(calls.map((c) => c.prompt)).toEqual([
      "Make the login page faster",
      "Drop the legacy exporter",
    ]);
    calls[0]?.answer("Faster login");
    calls[1]?.answer(null);
    await settle();
    expect(d3.engine.view(closed.id).title).toBe("Faster login");
    expect(d3.engine.view(killed.id).title).toBe("Drop the legacy exporter");
    expect(d3.changes).toContainEqual({
      type: "thread",
      thread: expect.objectContaining({ id: closed.id, title: "Faster login" }),
    });

    // Named, or settled on the stand-in: the next daemon asks nothing.
    engines.splice(engines.indexOf(d3.engine), 1);
    await d3.engine.close();
    const again = fakeTitler();
    daemon(new FakeAdapter(), { titler: again.titler });
    expect(again.calls).toEqual([]);
  });

  it("never asks on startup for threads given a title, or archived ones", async () => {
    const d1 = daemon(new FakeAdapter(), { titler: () => new Promise(() => {}) });
    await d1.engine.createThread({ project: "app", title: "Mine", prompt: "Do the thing" });
    const gone = await d1.engine.createThread({ project: "app", prompt: "Throw this away" });
    await d1.engine.archive(gone.id, { force: true });
    kill(d1);
    const { titler, calls } = fakeTitler();
    daemon(new FakeAdapter(), { titler });
    expect(calls).toEqual([]);
  });

  it("answers a create retried with the same client key with the thread it made, once", async () => {
    const d = daemon();
    const ask = { project: "app", prompt: "Add a dark mode", clientKey: "key-0123456789" };
    // The retry arrives while the first is still making its worktree, and again afterwards.
    const [a, b] = await Promise.all([d.engine.createThread(ask), d.engine.createThread(ask)]);
    const c = await d.engine.createThread(ask);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(d.engine.threads().map((t) => t.id)).toEqual([a.id]);
    expect(d.adapter.sessions.flatMap((s) => s.prompts)).toEqual(["Add a dark mode"]);

    // Another key is another thread.
    const other = await d.engine.createThread({ ...ask, clientKey: "key-abcdefghij" });
    expect(other.id).not.toBe(a.id);
  });

  it("refuses a client key reused for another project, prompt, title or model", async () => {
    const d = daemon();
    const ask = { project: "app", prompt: "Add a dark mode", clientKey: "key-reused-01" };
    const reused = /already used for another thread\.create/;
    // While the first is still being made, and after.
    const first = d.engine.createThread(ask);
    await expect(d.engine.createThread({ ...ask, prompt: "Add a light mode" })).rejects.toThrow(
      reused,
    );
    const made = await first;
    for (const other of [
      { ...ask, project: "web" },
      { ...ask, prompt: "Add a light mode" },
      { ...ask, title: "Dark" },
      { ...ask, model: "haiku" },
    ]) {
      await expect(d.engine.createThread(other)).rejects.toThrow(reused);
    }
    // The same words, give or take the spaces around them, are the same request.
    const again = await d.engine.createThread({ ...ask, prompt: " Add a dark mode\n" });
    expect(again.id).toBe(made.id);
    expect(d.engine.threads()).toHaveLength(1);
  });

  it("remembers client keys across a restart, and lets a failed create be retried", async () => {
    const d1 = daemon();
    const made = await d1.engine.createThread({ project: "app", prompt: "Hi", clientKey: "key-restart-1" });
    await expect(
      d1.engine.createThread({ project: "nope", prompt: "Hi", clientKey: "key-failed-01" }),
    ).rejects.toThrow(/No project/);
    kill(d1);
    const d2 = daemon();
    const again = await d2.engine.createThread({ project: "app", prompt: "Hi", clientKey: "key-restart-1" });
    expect(again.id).toBe(made.id);
    const retried = await d2.engine.createThread({ project: "app", prompt: "Hi", clientKey: "key-failed-01" });
    expect(retried.id).not.toBe(made.id);
    expect(d2.engine.threads()).toHaveLength(2);
  });

  it("lists the projects, in the snapshot too", async () => {
    const d = daemon();
    const projects = d.engine.projects();
    expect(projects).toEqual([
      {
        id: expect.stringMatching(/^prj_/),
        environmentId: d.store.environmentId,
        name: "app",
        defaultBranch: "main",
      },
    ]);
    expect(d.engine.snapshot().projects).toEqual(projects);
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

const PROMPTS = { discuss: "Talk first.", build: "Build it now." };

/** Starts a thread whose agent, on its first prompt, reads the repo and proposes. */
async function threadProposing(d: ReturnType<typeof daemon>) {
  d.adapter.onStart = (session) => {
    session.onPrompt = () => {
      if (session.prompts.length > 1) return;
      session.say("I read the repo.");
      session.propose("Add CONTRIBUTING.md with three rules.", "Add CONTRIBUTING.md");
    };
  };
  const thread = await d.engine.createThread({ project: "app", prompt: "add a CONTRIBUTING.md" });
  await settle();
  return thread;
}

describe("Engine: discuss, propose, build", () => {
  it("a new thread discusses with the discuss prompt; its proposal becomes a card", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const thread = await threadProposing(d);
    expect(d.adapter.last.input).toMatchObject({ phase: "discussing", prompts: PROMPTS });
    const [item] = d.engine.snapshot().items;
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      lane: "quick",
      kind: "proposal",
      ask: "Add CONTRIBUTING.md",
      context: "I read the repo.",
      suggested: "build",
      proposal: { headline: "Add CONTRIBUTING.md", summary: "Add CONTRIBUTING.md with three rules." },
    });
    expect(d.engine.view(thread.id)).toMatchObject({ phase: "discussing", activity: "needs-you" });
  });

  it("Build it reaches the agent and the thread is building, across a restart too", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const thread = await threadProposing(d);
    const [item] = d.engine.snapshot().items;
    const result = await d.engine.answer(item?.id ?? "", { kind: "proposal", decision: "build" });
    expect(result).toMatchObject({
      delivery: "live",
      item: { status: "resolved", resolution: { kind: "approved" } },
      thread: { phase: "building" },
    });
    expect(d.adapter.last.answered).toEqual([{ requestId: item?.requestId, decision: "build" }]);
    expect(d.changes.some((c) => c.type === "thread" && c.thread.phase === "building")).toBe(true);

    // The next session (a resume, here after a restart) starts building, with the build prompt.
    d.adapter.last.complete();
    await settle();
    kill(d);
    const next = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    expect(next.engine.view(thread.id).phase).toBe("building");
    next.engine.send(thread.id, "also add a code of conduct");
    expect(next.adapter.last.input).toMatchObject({ phase: "building", prompts: PROMPTS });
  });

  it("Change something sends the note; the thread keeps discussing and can propose again", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const thread = await threadProposing(d);
    const [item] = d.engine.snapshot().items;
    await expect(
      d.engine.answer(item?.id ?? "", { kind: "proposal", decision: "change", note: "" }),
    ).rejects.toThrow("Say what to change.");
    const result = await d.engine.answer(item?.id ?? "", {
      kind: "proposal",
      decision: "change",
      note: "Five rules",
    });
    expect(result.item.resolution).toEqual({ kind: "revise", note: "Five rules" });
    expect(d.adapter.last.answered).toEqual([
      { requestId: item?.requestId, decision: "change", note: "Five rules" },
    ]);
    expect(d.engine.view(thread.id).phase).toBe("discussing");
    d.adapter.last.propose("Add CONTRIBUTING.md with five rules.", "Five rules");
    await settle();
    expect(d.engine.snapshot().items).toMatchObject([{ kind: "proposal", ask: "Five rules" }]);
  });

  it("a proposal left open by a kill: Build it resumes the agent building, told it's approved", async () => {
    const first = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const thread = await threadProposing(first);
    const sessionId = first.adapter.last.sessionId;
    kill(first);

    const second = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const [item] = second.engine.snapshot().items;
    expect(item).toMatchObject({ kind: "proposal", status: "open", detached: true });
    const result = await second.engine.answer(item?.id ?? "", {
      kind: "proposal",
      decision: "build",
    });
    expect(result).toMatchObject({ delivery: "message", thread: { phase: "building" } });
    const resumed = second.adapter.last;
    expect(resumed.input).toMatchObject({ resumeSessionId: sessionId, phase: "building" });
    expect(resumed.prompts[0]).toBe(
      "Your session ended while you were waiting for my answer to your proposal: Add CONTRIBUTING.md\nApproved, build it. Carry on from where you left off.",
    );
    expect(second.engine.view(thread.id).phase).toBe("building");
  });

  it("reads the prompts as each session starts, so an edit applies to the next one", async () => {
    let discuss = "v1";
    const d = daemon(new FakeAdapter(), { prompts: () => ({ discuss, build: "b" }) });
    await threadProposing(d);
    expect(d.adapter.last.input.prompts?.discuss).toBe("v1");
    discuss = "v2";
    d.adapter.last.crash();
    await settle();
    const thread = d.engine.threads()[0];
    d.engine.send(thread?.id ?? "", "go on");
    expect(d.adapter.last.input.prompts?.discuss).toBe("v2");
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

describe("Engine: standing answers match the full request, never the shown copy", () => {
  const long = "x".repeat(2100);
  const approved = { command: `${long} && echo ok!` };
  const other = { command: `${long} && rm -rf ~` };

  async function allowDetached(d: ReturnType<typeof daemon>, reask: Record<string, unknown>) {
    d.adapter.onStart = (s) => {
      s.onPrompt = () => s.askPermission("Bash", approved);
    };
    await d.engine.createThread({ project: "app", prompt: "build" });
    await settle();
    d.adapter.last.crash();
    await settle();
    d.adapter.onStart = (s) => {
      s.onPrompt = () => s.askPermission("Bash", reask);
    };
    const [item] = d.engine.snapshot().items;
    d.changes.length = 0; // from here on: what clients see of the resumed turn
    await d.engine.answer(item?.id ?? "", { kind: "permission", decision: "allow" });
    await settle();
    return d.adapter.last;
  }

  it("asks again for a request that differs only beyond what events keep", async () => {
    const d = daemon();
    const resumed = await allowDetached(d, other);
    expect(resumed.answered).toEqual([]); // not allowed for you
    const [open] = d.engine.snapshot().items;
    expect(open).toMatchObject({ kind: "permission", detached: false, status: "open" });
    // Shown alike, asked differently.
    const first = d.engine.events(open?.threadId ?? "").events.find(
      (e) => e.event.type === "request.opened",
    );
    expect(first?.event.type === "request.opened" && first.event.payload.input).toEqual(
      open?.permission?.input,
    );
  });

  it("answers the identical request quietly: subscribers never see it open", async () => {
    const d = daemon();
    const resumed = await allowDetached(d, approved);
    expect(resumed.answered).toEqual([{ requestId: expect.any(String), decision: "allow" }]);
    const quietId = `itm_${resumed.answered[0]?.requestId.slice(4)}`;
    const told = d.changes.filter((c) => c.type === "item" && c.change.item.id === quietId);
    expect(told).toEqual([]);
    // Nor does the thread ever look like it needs you.
    const needy = d.changes.filter((c) => c.type === "thread" && c.thread.activity === "needs-you");
    expect(needy).toEqual([]);
    expect(d.engine.snapshot().items).toEqual([]);
  });

  it("shows the item after all when the answer can't reach the agent", async () => {
    const d = daemon();
    d.adapter.onStart = (s) => {
      s.onPrompt = () => s.askPermission("Bash", approved);
    };
    await d.engine.createThread({ project: "app", prompt: "build" });
    await settle();
    d.adapter.last.crash();
    await settle();
    d.adapter.onStart = (s) => {
      s.onPrompt = () => {
        s.askPermission("Bash", approved);
        s.crash(); // gone before the standing answer arrives
      };
    };
    const [item] = d.engine.snapshot().items;
    d.changes.length = 0;
    await d.engine.answer(item?.id ?? "", { kind: "permission", decision: "allow" });
    await settle();
    const [left] = d.engine.snapshot().items;
    expect(left).toMatchObject({ status: "open", detached: true });
    const told = d.changes.flatMap((c) =>
      c.type === "item" && c.change.item.id === left?.id ? [c.change.type] : [],
    );
    expect(told).toEqual(["opened", "detached"]);
    expect(d.engine.view(left?.threadId ?? "").activity).toBe("needs-you");
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
    const types = d.engine.events(thread.id).events.map((e) => e.event.type);
    expect(types.at(-1)).toBe("thread.archived");
  });

  it("a refused archive leaves the running turn alone", async () => {
    const d = daemon();
    const thread = await threadAsking(d);
    writeFileSync(join(thread.worktreePath, "work.txt"), "unsaved");
    await expect(d.engine.archive(thread.id)).rejects.toThrow(/uncommitted changes/);
    expect(d.adapter.last.stopped).toBe(false);
    expect(d.engine.snapshot().items).toMatchObject([{ detached: false }]);
    expect(d.engine.view(thread.id).status).toBe("active");
  });
});

describe("Engine: finished work", () => {
  const shot = {
    id: "att_aaaaaaaaaaaaaaaaaaaa",
    file: "att_aaaaaaaaaaaaaaaaaaaa.png",
    name: "counter.png",
    mediaType: "image/png",
    bytes: 12,
  } as const;

  /** A thread whose agent, on the prompt, attaches, exposes and reports, then ends its turn. */
  async function threadReporting(d: ReturnType<typeof daemon>) {
    d.adapter.onStart = (session) => {
      session.onPrompt = () => {
        session.respondToProposal(session.propose("Add a counter page."), "build");
        session.attach(shot);
        session.expose(5173, "counter");
        session.say("Built the counter.");
        session.report("Added a counter page.", {
          headline: "Counter works",
          howToTest: "Open it and tap.",
          checks: [{ name: "Tests", status: "pass", detail: "3 passed" }],
        });
        session.complete();
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "Add a counter" });
    await settle();
    return thread;
  }

  it("a report becomes a review-lane card, and the thread is in review", async () => {
    const d = daemon();
    const thread = await threadReporting(d);
    expect(d.adapter.last.input.attachmentsDir).toBe(join(home, "attachments", thread.id));
    const [item] = d.engine.snapshot().items;
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      lane: "review",
      kind: "finished",
      ask: "Counter works",
      finished: {
        summary: "Added a counter page.",
        checks: [{ name: "Tests", status: "pass", detail: "3 passed" }],
        attachments: [shot],
        live: { port: 5173, path: "counter" },
      },
    });
    expect(d.engine.view(thread.id)).toMatchObject({
      phase: "review",
      activity: "needs-you",
      working: false,
    });
    expect(d.engine.livePort(thread.id)).toBe(5173);
  });

  it("Done resolves it without bothering the agent, even after the agent has stopped", async () => {
    const d = daemon();
    const thread = await threadReporting(d);
    await d.adapter.last.stop();
    await settle();
    const [item] = d.engine.snapshot().items;
    expect(item).toMatchObject({ kind: "finished", detached: false });
    await expect(
      d.engine.answer(item?.id ?? "", { kind: "permission", decision: "allow" }),
    ).rejects.toThrow(/is finished work; answer it with done/);
    const sessions = d.adapter.sessions.length;
    const result = await d.engine.answer(item?.id ?? "", { kind: "finished", decision: "done" });
    expect(result).toMatchObject({
      delivery: "none",
      item: { status: "resolved", resolution: { kind: "done" } },
      thread: { phase: "review", activity: "idle" },
    });
    expect(d.adapter.sessions.length).toBe(sessions); // nothing resumed, nothing sent
    expect(d.engine.snapshot().items).toEqual([]);
    expect(d.engine.events(thread.id).events.at(-1)?.event.type).toBe("report.resolved");
  });

  it("a newer report replaces the card, and the replaced card's screenshot copies go", async () => {
    const d = daemon();
    const thread = await threadReporting(d);
    const dir = join(home, "attachments", thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, shot.file), "png");
    const next = { ...shot, id: "att_bbbbbbbbbbbbbbbbbbbb", file: "att_bbbbbbbbbbbbbbbbbbbb.png" } as const;
    writeFileSync(join(dir, next.file), "png");
    d.engine.send(thread.id, "again");
    d.adapter.last.onPrompt = () => {
      d.adapter.last.attach(next);
      d.adapter.last.report("Second go.");
      d.adapter.last.complete();
    };
    await settle();
    await expect.poll(() => existsSync(join(dir, shot.file))).toBe(false);
    expect(existsSync(join(dir, next.file))).toBe(true);
    expect(d.engine.snapshot().items).toMatchObject([
      { kind: "finished", finished: { summary: "Second go.", attachments: [next] } },
    ]);
  });

  it("counts the screenshots a thread holds toward the next session's cap", async () => {
    const d = daemon();
    d.adapter.onStart = (session) => {
      session.onPrompt = () => {
        session.attach(shot);
        session.complete();
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "shoot" });
    await settle();
    await d.adapter.last.stop();
    await settle();
    d.engine.send(thread.id, "again");
    expect(d.adapter.last.input.pendingAttachments).toBe(1);
  });

  it("the card and the live port survive a restart", async () => {
    const first = daemon();
    const thread = await threadReporting(first);
    kill(first);
    const second = daemon();
    expect(second.engine.snapshot().items).toMatchObject([
      { kind: "finished", status: "open", detached: false, finished: { attachments: [shot] } },
    ]);
    expect(second.engine.livePort(thread.id)).toBe(5173);
  });

  it("only an active thread's exposed port is live; archiving removes its attachments", async () => {
    const d = daemon();
    const thread = await threadReporting(d);
    const dir = join(home, "attachments", thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, shot.file), "png");
    expect(d.engine.livePort("thr_nope")).toBeNull();
    expect(d.engine.livePort("../../etc")).toBeNull();
    await d.engine.archive(thread.id);
    expect(d.engine.livePort(thread.id)).toBeNull();
    expect(existsSync(dir)).toBe(false);
  });
});
