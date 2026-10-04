import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Command,
  CommandResults,
  QueueItem,
  StoredEvent,
  ThreadView,
  type UserInputQuestion,
} from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter, type FakeSession } from "./agent/fake-agent.ts";
import { carryOn, RESTART_PROMPT } from "./answers.ts";
import { executeCommand } from "./commands.ts";
import { Engine, type EngineChange, type EngineOptions, MAX_CHILD_THREADS, sentence, STILL_LANDED } from "./engine.ts";
import { STALLED_PROMPT } from "./prompts.ts";
import { addProject, findProject } from "./projects.ts";
import { openStore, type Store } from "./store.ts";
import { initRepo, removeTempDirs, sh, tempDir } from "./testing.ts";
import { getThread, projectOf } from "./threads.ts";

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

/** A thread started with `model: "haiku"` runs it in every phase. */
const HAIKU = { discuss: { model: "haiku" }, build: { model: "haiku" } };

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
  options: Pick<EngineOptions, "titler" | "defaultModel" | "prompts" | "snoozeMs"> = {},
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
    expect(session.input).toMatchObject({ cwd: thread.worktreePath, models: HAIKU });
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
    expect(second.input).toMatchObject({ resumeSessionId: first.sessionId, models: HAIKU });
    expect(second.prompts).toEqual(["again"]);
  });

  it("records a failure to start the agent as an error item that keeps the prompts it couldn't send", async () => {
    const adapter = new FakeAdapter();
    adapter.failWith = new Error("claude not found");
    const d = daemon(adapter);
    const thread = await d.engine.createThread({ project: "app", prompt: "hi" });
    const { events } = d.engine.events(thread.id);
    expect(events.map((e) => e.event.type)).toEqual(["runtime.error"]);
    expect(JSON.stringify(events[0]?.event)).toMatch(/Couldn't start claude: claude not found/);
    expect(d.engine.view(thread.id)).toMatchObject({ queued: 0, activity: "needs-you" });
    const [item] = d.engine.snapshot().items;
    expect(item).toMatchObject({
      kind: "error",
      lane: "quick",
      ask: "Claude couldn't start",
      error: { cause: "start", prompts: ["hi"] },
    });

    // Fixed (claude installed): Retry sends the prompt that never went.
    adapter.failWith = undefined;
    await d.engine.answer(item?.id ?? "", { kind: "error", action: "retry" });
    await settle();
    expect(adapter.last.prompts).toEqual(["hi"]);
    expect(d.engine.snapshot().items).toEqual([]);
  });

  it("runs threads started without a model on the default model, if there is one", async () => {
    const d = daemon(new FakeAdapter(), { defaultModel: "haiku" });
    await d.engine.createThread({ project: "app", prompt: "cheap" });
    expect(d.adapter.last.input.models?.discuss.model).toBe("haiku");
    await d.engine.createThread({ project: "app", prompt: "dear", model: "opus" });
    expect(d.adapter.last.input.models?.discuss.model).toBe("opus");
    const plain = daemon();
    await plain.engine.createThread({ project: "app", prompt: "default" });
    expect(plain.adapter.last.input.models).toEqual({ discuss: {}, build: {} });
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

const PROMPTS = { discuss: "Talk first.", build: "Build it now.", landing: "Land it." };

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
    const d = daemon(new FakeAdapter(), { prompts: () => ({ discuss, build: "b", landing: "l" }) });
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
    expect(resumed.input).toMatchObject({ resumeSessionId: sessionId, models: HAIKU });
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
    // The cut-short turn picks up first, then what was waiting.
    expect(second.adapter.last.prompts).toEqual([RESTART_PROMPT]);
    expect(second.adapter.last.input.resumeSessionId).toBe(first.adapter.last.sessionId);
    second.adapter.last.complete();
    await settle();
    expect(second.adapter.last.prompts).toEqual([RESTART_PROMPT, "second"]);
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
    ).rejects.toThrow(/is finished work; answer it with merge, pr, done/);
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

describe("Engine: review actions and landing", () => {
  const PR = "https://github.com/o/r/pull/12";

  /** A thread whose agent proposes, builds and reports, then ends its turn: finished work waits. */
  async function threadFinished(d: ReturnType<typeof daemon>) {
    d.adapter.onStart = (session) => {
      session.onPrompt = () => {
        session.respondToProposal(session.propose("Add a counter page."), "build");
        session.report("Added a counter page.", { headline: "Counter works" });
        session.complete();
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "Add a counter" });
    await settle();
    d.adapter.onStart = undefined;
    const session = d.adapter.last;
    session.onPrompt = undefined;
    const item = d.engine.snapshot().items[0];
    if (!item) throw new Error("no finished card");
    return { thread, item, session };
  }

  /** A graceful stop, as `tenzo serve` does on Ctrl-C. */
  async function shutDown(d: ReturnType<typeof daemon>) {
    await d.engine.close();
    engines.splice(engines.indexOf(d.engine), 1);
    stores.splice(stores.indexOf(d.store), 1);
    d.store.close();
  }

  const repoOf = (d: ReturnType<typeof daemon>, threadId: string) =>
    projectOf(d.store, getThread(d.store, threadId)).path;

  it("Merge sends the landing prompt as the next turn; landed archives the thread when it ends", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    const result = await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    expect(result).toMatchObject({
      delivery: "message",
      item: { status: "resolved", resolution: { kind: "merge" } },
      thread: { phase: "landing", activity: "working" },
    });
    expect(session.prompts.at(-1)).toMatch(/^Merge: land this work through a PR\./);
    expect(session.prompts.at(-1)).toMatch(/Land it\.$/);
    // The running session sees the new phase: its landing tools now work.
    expect(session.input.host?.phase()).toBe("landing");

    session.landed(PR);
    await settle();
    expect(d.engine.view(thread.id).status).toBe("active"); // not mid-turn
    session.complete();
    await expect.poll(() => d.engine.view(thread.id).status).toBe("archived");
    expect(session.stopped).toBe(true);
    expect(existsSync(thread.worktreePath)).toBe(false);
    expect(sh(repoOf(d, thread.id), "branch", "--list", thread.branch)).toContain(thread.branch);
    expect(d.engine.events(thread.id).events.map((e) => e.event.type).slice(-3)).toEqual([
      "turn.completed",
      "session.exited",
      "thread.archived",
    ]);
  });

  it("Merge after the agent stopped resumes it landing, with the landing prompt", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    await session.stop();
    await settle();
    await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    const resumed = d.adapter.last;
    expect(resumed).not.toBe(session);
    expect(resumed.input).toMatchObject({ resumeSessionId: session.sessionId, phase: "landing" });
    expect(resumed.prompts).toEqual([expect.stringMatching(/^Merge: /)]);
    expect(d.engine.view(thread.id).phase).toBe("landing");
  });

  it("Open PR: the thread lands; a ready PR is a quick card, and its Merge goes to the agent", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    session.onPrompt = () => {
      session.say("PR is up; CI is green.");
      session.readyToMerge(PR, "Checks green, one approval.", "PR #12 can merge");
      session.complete();
    };
    await d.engine.answer(item.id, { kind: "finished", decision: "pr" });
    expect(session.prompts.at(-1)).toMatch(/^Open PR: .*don't merge it/);
    await settle();
    const [ready] = d.engine.snapshot().items;
    expect(QueueItem.parse(ready)).toEqual(ready);
    expect(ready).toMatchObject({
      kind: "ready",
      lane: "quick",
      ask: "PR #12 can merge",
      context: "PR is up; CI is green.",
      ready: { url: PR },
    });
    expect(d.engine.view(thread.id)).toMatchObject({ phase: "landing", activity: "needs-you" });

    await expect(
      d.engine.answer(ready?.id ?? "", { kind: "ready", decision: "changes", note: " " }),
    ).rejects.toThrow(/what to do before merging/);
    session.onPrompt = () => {
      session.landed(PR);
      session.complete();
    };
    const merged = await d.engine.answer(ready?.id ?? "", { kind: "ready", decision: "merge" });
    expect(merged).toMatchObject({ delivery: "message", item: { resolution: { kind: "merge" } } });
    expect(session.prompts.at(-1)).toMatch(/^Merge: merge the PR now with `gh pr merge`/);
    await expect.poll(() => d.engine.view(thread.id).status).toBe("archived");
  });

  it("Needs changes sends the note back and the thread builds; its next report is a new card", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    await expect(
      d.engine.answer(item.id, { kind: "finished", decision: "changes" }),
    ).rejects.toThrow(/Say what needs changing/);
    session.onPrompt = () => {}; // still building when we look
    const result = await d.engine.answer(item.id, {
      kind: "finished",
      decision: "changes",
      note: " Make the button bigger. ",
    });
    expect(result).toMatchObject({
      delivery: "message",
      item: { resolution: { kind: "changes", note: "Make the button bigger." } },
      thread: { phase: "building" },
    });
    expect(session.prompts.at(-1)).toBe(
      "Needs changes: Make the button bigger.\n\nMake the change, run the checks, commit, and `report` again.",
    );
    session.report("Bigger button.", { headline: "Button is bigger" });
    session.complete();
    await settle();
    expect(d.engine.snapshot().items).toMatchObject([
      { kind: "finished", ask: "Button is bigger", suggested: "merge" },
    ]);
    expect(d.engine.view(thread.id).phase).toBe("review");
  });

  it("wake_me: the agent gets a turn with why on time, and a newer wake replaces it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const d = daemon();
      d.adapter.onStart = (session) => {
        session.onPrompt = () => {
          session.wakeMe(5 * 60_000, "Check CI");
          session.wakeMe(10 * 60_000, "Check CI and reviews");
          session.complete();
        };
      };
      const thread = await d.engine.createThread({ project: "app", prompt: "Watch the PR" });
      await settle();
      const session = d.adapter.last;
      session.onPrompt = undefined;
      expect(d.engine.view(thread.id)).toMatchObject({
        activity: "idle",
        wakeAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
      vi.advanceTimersByTime(9 * 60_000);
      await settle();
      expect(session.prompts).toEqual(["Watch the PR"]);
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(session.prompts.at(-1)).toBe("You asked to be woken: Check CI and reviews");
      expect(session.prompts).toHaveLength(2);
      expect(d.engine.view(thread.id)).toMatchObject({ wakeAt: null, activity: "working" });
      expect(d.engine.events(thread.id).events.map((e) => e.event.type)).toContain("wake.fired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("wake_me survives a restart: re-armed on start, or rung at once if its time passed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const first = daemon();
      first.adapter.onStart = (session) => {
        session.onPrompt = () => {
          session.wakeMe(10 * 60_000, "Check CI");
          session.complete();
        };
      };
      const thread = await first.engine.createThread({ project: "app", prompt: "Watch the PR" });
      await settle();
      const asleep = first.adapter.last;
      await shutDown(first);

      // A daemon up again before the time: it re-arms the wake.
      const second = daemon();
      expect(second.engine.view(thread.id).wakeAt).not.toBeNull();
      vi.advanceTimersByTime(10 * 60_000 - 1);
      await settle();
      expect(second.adapter.sessions).toHaveLength(0);
      vi.advanceTimersByTime(1);
      await settle();
      expect(second.adapter.last.input.resumeSessionId).toBe(asleep.sessionId);
      expect(second.adapter.last.prompts).toEqual(["You asked to be woken: Check CI"]);

      // The time passes while no daemon runs: the next one wakes it at once.
      second.adapter.last.wakeMe(10 * 60_000, "Look again");
      second.adapter.last.complete();
      await settle();
      await shutDown(second);
      vi.advanceTimersByTime(60 * 60_000);
      const third = daemon();
      vi.advanceTimersByTime(0);
      await settle();
      expect(third.adapter.last.prompts).toEqual(["You asked to be woken: Look again"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("archiving drops a wake; a wake never wakes an archived thread", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const d = daemon();
      d.adapter.onStart = (session) => {
        session.onPrompt = () => {
          session.wakeMe(60_000, "Check CI");
          session.complete();
        };
      };
      const thread = await d.engine.createThread({ project: "app", prompt: "Watch" });
      await settle();
      const sessions = d.adapter.sessions.length;
      await d.engine.archive(thread.id);
      vi.advanceTimersByTime(5 * 60_000);
      await settle();
      expect(d.adapter.sessions).toHaveLength(sessions);
      expect(d.engine.view(thread.id)).toMatchObject({ status: "archived", wakeAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a thread that landed before a kill is archived by the next daemon", async () => {
    const first = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(first);
    await first.engine.answer(item.id, { kind: "finished", decision: "merge" });
    session.landed(PR);
    await settle();
    kill(first);
    const second = daemon();
    await expect.poll(() => second.engine.view(thread.id).status).toBe("archived");
    expect(second.adapter.sessions).toHaveLength(0); // nothing resumed for it
  });

  it("a landed thread that can't be archived (work left over) stays, with an error card", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    writeFileSync(join(thread.worktreePath, "stray.txt"), "left over");
    session.landed(PR);
    session.complete();
    await expect.poll(() => d.engine.snapshot().items).toMatchObject([
      {
        kind: "error",
        lane: "quick",
        ask: "Landed, but not archived",
        error: { cause: "unarchived", message: expect.stringMatching(/uncommitted changes/) },
      },
    ]);
    // The card says it still archives once a turn ends, whatever Retry gives it to do.
    expect(d.engine.snapshot().items[0]?.error?.message).toContain(STILL_LANDED);
    expect(STILL_LANDED).toMatch(/already marked landed, so it archives at its next turn end or when Tenzo restarts/);
    expect(d.engine.snapshot().items[0]?.error?.message).toMatch(/[^.][.!?] It's already marked landed/);
    // Git's errors mostly end without a period: the next sentence doesn't run into them.
    expect(sentence("fatal: not a git repository\n")).toBe("fatal: not a git repository.");
    expect(sentence("Commit them first.")).toBe("Commit them first.");
    expect(d.engine.view(thread.id)).toMatchObject({ status: "active", phase: "landing" });
    // Retry tells the agent what is in the way.
    const [card] = d.engine.snapshot().items;
    session.onPrompt = () => {};
    await d.engine.answer(card?.id ?? "", { kind: "error", action: "retry" });
    expect(session.prompts.at(-1)).toMatch(/couldn't archive this thread after `landed`.*call `landed` again/s);
  });

  it("a message sent while it landed isn't dropped: it stays, with your message on a card", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    session.onPrompt = () => {};
    await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    d.engine.send(thread.id, "Also update the README"); // waits for the landing turn
    session.landed(PR);
    await settle();
    // Once it has said it landed, Tenzo says so instead of taking more.
    expect(() => d.engine.send(thread.id, "One more thing")).toThrow(/has landed/);
    session.complete();
    await expect.poll(() => d.engine.snapshot().items).toMatchObject([
      {
        kind: "error",
        error: {
          cause: "unarchived",
          prompts: ["Also update the README"],
          message: expect.stringContaining(STILL_LANDED),
        },
      },
    ]);
    expect(d.engine.view(thread.id)).toMatchObject({ status: "active", queued: 0 });
    expect(existsSync(thread.worktreePath)).toBe(true);
    const [card] = d.engine.snapshot().items;
    await d.engine.answer(card?.id ?? "", { kind: "error", action: "retry" });
    expect(session.prompts.at(-1)).toBe("Also update the README");
    // As the card said: once that turn ends, it archives.
    session.complete();
    await expect.poll(() => d.engine.view(thread.id).status).toBe("archived");
  });

  it("a landing turn that ends with nothing to come gets an error card; Retry reminds it", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    session.onPrompt = () => {
      session.say("Can I merge this to main directly?");
      session.complete();
    };
    await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    await settle();
    const [card] = d.engine.snapshot().items;
    expect(card).toMatchObject({
      kind: "error",
      ask: "Landing stalled",
      context: "Can I merge this to main directly?",
      error: { cause: "stalled", prompts: [STALLED_PROMPT] },
    });
    expect(d.engine.view(thread.id)).toMatchObject({ phase: "landing", activity: "needs-you" });
    session.onPrompt = () => {
      session.wakeMe(10 * 60_000, "Check CI");
      session.complete();
    };
    await d.engine.answer(card?.id ?? "", { kind: "error", action: "retry" });
    await settle();
    expect(session.prompts.at(-1)).toBe(STALLED_PROMPT);
    // A turn that leaves a wake (or a card, or `landed`) is no stall.
    expect(d.engine.snapshot().items).toEqual([]);
    expect(d.engine.view(thread.id).wakeAt).not.toBeNull();
  });

  it("a landing turn followed by a queued prompt is no stall: the next turn just starts", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    session.onPrompt = () => {};
    await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    d.engine.send(thread.id, "Also check the README"); // queued behind the landing turn
    session.say("Pushed; opening the PR next.");
    session.complete();
    await settle();
    expect(session.prompts.at(-1)).toBe("Also check the README");
    const types = d.engine.events(thread.id).events.map((e) => e.event.type);
    expect(types).not.toContain("landing.stuck");
    expect(types.slice(types.lastIndexOf("turn.completed"))).toEqual(["turn.completed", "turn.started"]);
    expect(d.engine.snapshot().items).toEqual([]);
  });

  it("Merge answered while a turn runs waits for it; the thread is landing at once", async () => {
    const d = daemon(new FakeAdapter(), { prompts: () => PROMPTS });
    const { thread, item, session } = await threadFinished(d);
    session.onPrompt = () => {};
    d.engine.send(thread.id, "Tidy the commit message");
    const result = await d.engine.answer(item.id, { kind: "finished", decision: "merge" });
    expect(result).toMatchObject({ delivery: "message", thread: { phase: "landing", queued: 1 } });
    expect(session.prompts.at(-1)).toBe("Tidy the commit message");
    session.complete();
    await settle();
    expect(session.prompts.at(-1)).toMatch(/^Merge: /);
  });

  it("landed is believed only when git agrees: clean worktree, changes on origin", async () => {
    const d = daemon();
    await d.engine.createThread({ project: "app", prompt: "Land it" });
    const thread = d.engine.threads()[0];
    const host = d.adapter.last.input.host;
    if (!thread || !host) throw new Error("no thread");
    writeFileSync(join(thread.worktreePath, "stray.txt"), "left over");
    await expect(host.checkLanded()).rejects.toThrow(/uncommitted changes/);
    rmSync(join(thread.worktreePath, "stray.txt"));
    // This repo has no origin: nothing can be shown to have landed.
    await expect(host.checkLanded()).rejects.toThrow(/Couldn't fetch main from origin/);
  });

  it("start_thread: a new thread through the normal create, origin agent, its parent recorded", async () => {
    const d = daemon();
    const parent = await d.engine.createThread({ project: "app", prompt: "Review open PRs" });
    const host = d.adapter.last.input.host;
    if (!host) throw new Error("no host");
    const child = await host.startThread({ prompt: "Fix the flaky test", title: "Flaky test" });
    expect(child).toMatchObject({ title: "Flaky test", projectName: "app", branch: "tenzo/flaky-test" });
    const view = d.engine.view(child.id);
    expect(ThreadView.parse(view)).toEqual(view);
    expect(view).toMatchObject({ origin: "agent", parentId: parent.id, phase: "discussing" });
    expect(d.engine.view(parent.id)).toMatchObject({ origin: "user", parentId: null });
    // Its own agent starts on the prompt, discussing like any thread.
    const childSession = d.adapter.last;
    expect(childSession.input).toMatchObject({ threadId: child.id, phase: "discussing" });
    expect(childSession.prompts).toEqual(["Fix the flaky test"]);
    await expect(host.startThread({ prompt: "x", project: "nope" })).rejects.toThrow(/No project "nope"/);
    // No fan-out: a thread an agent started can't start threads.
    await expect(childSession.input.host?.startThread({ prompt: "Fan out" })).rejects.toThrow(
      /started by another thread/,
    );
  });

  it("start_thread: a few children per thread, counted across sessions, and a few agent threads in all", async () => {
    const d = daemon();
    const a = await d.engine.createThread({ project: "app", prompt: "Spawn" });
    const first = d.adapter.last;
    const b = await d.engine.createThread({ project: "app", prompt: "Spawn too" });
    const other = d.adapter.last;
    const children = [];
    for (let i = 0; i < MAX_CHILD_THREADS; i++) {
      children.push(await first.input.host?.startThread({ prompt: `Job ${i}`, title: `Job ${i}` }));
    }
    // A new session of the same thread (a wake, a restart) doesn't start the count again.
    first.crash();
    await settle();
    d.engine.send(a.id, "Go on");
    const again = d.adapter.last;
    expect(again.input.threadId).toBe(a.id);
    await expect(again.input.host?.startThread({ prompt: "One more" })).rejects.toThrow(
      `A thread starts at most ${MAX_CHILD_THREADS} threads.`,
    );
    // Across every thread, at most MAX_AGENT_THREADS active at once.
    await expect(other.input.host?.startThread({ prompt: "Mine" })).rejects.toThrow(
      /threads started by agents are active already/,
    );
    await d.engine.archive(children[0]?.id ?? "");
    await expect(other.input.host?.startThread({ prompt: "Mine" })).resolves.toMatchObject({
      projectName: "app",
    });
    expect(d.engine.view(b.id).origin).toBe("user");
  });

  it("a wake that comes due mid-turn waits for the turn, like any message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const d = daemon();
      d.adapter.onStart = (session) => {
        session.onPrompt = () => {
          session.wakeMe(60_000, "Check CI");
          session.complete();
        };
      };
      const thread = await d.engine.createThread({ project: "app", prompt: "Watch" });
      await settle();
      const session = d.adapter.last;
      session.onPrompt = () => {};
      d.engine.send(thread.id, "Meanwhile, a question");
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(session.prompts.at(-1)).toBe("Meanwhile, a question");
      expect(d.engine.view(thread.id).queued).toBe(1);
      session.complete();
      await settle();
      expect(session.prompts.at(-1)).toBe("You asked to be woken: Check CI");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Engine: snooze", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  /** Timers and Date on a fake clock; setImmediate stays real, for `settle`. */
  const fakeClock = () =>
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
      now: Date.parse("2026-10-04T10:00:00Z"),
    });

  it("snoozes an item for 15 minutes: it stays open, its thread stops needing you, clients hear", async () => {
    fakeClock();
    const d = daemon();
    const thread = await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    const { item: snoozed, thread: view } = d.engine.snooze(item?.id ?? "");
    expect(snoozed).toMatchObject({ status: "open", snoozedUntil: "2026-10-04T10:15:00.000Z" });
    expect(view).toMatchObject({ activity: "snoozed", openItems: 1 });
    expect(d.engine.snapshot().items).toEqual([snoozed]); // still sent: clients hide it themselves
    expect(d.changes.filter((c) => c.type === "item").map((c) => c.change.type)).toEqual([
      "opened",
      "snoozed",
    ]);
    expect(d.changes.at(-1)).toMatchObject({ type: "thread", thread: { activity: "snoozed" } });
    expect(d.engine.events(thread.id).events.at(-1)?.event).toMatchObject({
      type: "item.snoozed",
      requestId: item?.requestId,
      payload: { until: "2026-10-04T10:15:00.000Z" },
    });
  });

  it("wakes the item by itself when its time comes", async () => {
    fakeClock();
    const d = daemon();
    const thread = await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    d.engine.snooze(item?.id ?? "");
    vi.advanceTimersByTime(15 * 60_000 - 1);
    expect(d.engine.snapshot().items[0]?.snoozedUntil).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(d.engine.snapshot().items[0]?.snoozedUntil).toBeNull();
    expect(d.engine.view(thread.id).activity).toBe("needs-you");
    expect(d.changes.filter((c) => c.type === "item").at(-1)).toMatchObject({
      change: { type: "unsnoozed", item: { id: item?.id, snoozedUntil: null } },
    });
    expect(d.engine.events(thread.id).events.at(-1)?.event).toMatchObject({
      type: "item.unsnoozed",
      payload: { reason: "returned" },
    });
  });

  it("Undo brings it back at once; the timer then does nothing; undoing again is harmless", async () => {
    fakeClock();
    const d = daemon();
    const thread = await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    d.engine.snooze(item?.id ?? "");
    const { item: back } = d.engine.unsnooze(item?.id ?? "");
    expect(back.snoozedUntil).toBeNull();
    const seq = d.engine.view(thread.id).lastSeq;
    expect(d.engine.unsnooze(item?.id ?? "").item.snoozedUntil).toBeNull();
    vi.advanceTimersByTime(20 * 60_000);
    expect(d.engine.view(thread.id).lastSeq).toBe(seq); // nothing more logged
  });

  it("survives a restart: still snoozed, and woken on time by the next daemon", async () => {
    fakeClock();
    const first = daemon();
    await threadAsking(first);
    const [item] = first.engine.snapshot().items;
    first.engine.snooze(item?.id ?? "");
    kill(first);

    const second = daemon();
    expect(second.engine.snapshot().items[0]?.snoozedUntil).toBe("2026-10-04T10:15:00.000Z");
    vi.advanceTimersByTime(15 * 60_000);
    expect(second.engine.snapshot().items[0]?.snoozedUntil).toBeNull();
  });

  it("an item whose time came while no daemon ran wakes as the next one starts", async () => {
    fakeClock();
    const first = daemon();
    await threadAsking(first);
    const [item] = first.engine.snapshot().items;
    first.engine.snooze(item?.id ?? "");
    await first.engine.close();
    vi.setSystemTime(Date.parse("2026-10-04T11:00:00Z"));
    const second = daemon();
    vi.advanceTimersByTime(0);
    expect(second.engine.snapshot().items[0]?.snoozedUntil).toBeNull();
  });

  it("takes its length from the options (TENZO_SNOOZE_MS)", async () => {
    fakeClock();
    const d = daemon(new FakeAdapter(), { snoozeMs: 5_000 });
    await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    expect(d.engine.snooze(item?.id ?? "").item.snoozedUntil).toBe("2026-10-04T10:00:05.000Z");
    vi.advanceTimersByTime(5_000);
    expect(d.engine.snapshot().items[0]?.snoozedUntil).toBeNull();
  });

  it("an item answered while snoozed resolves, and its timer goes with it", async () => {
    fakeClock();
    const d = daemon();
    const thread = await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    d.engine.snooze(item?.id ?? "");
    await d.engine.answer(item?.id ?? "", blue);
    const seq = d.engine.view(thread.id).lastSeq;
    vi.advanceTimersByTime(15 * 60_000);
    expect(d.engine.view(thread.id).lastSeq).toBe(seq);
  });

  it("refuses unknown and resolved items, through the command layer too", async () => {
    const d = daemon();
    await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    expect(() => d.engine.snooze("itm_nope")).toThrow(/No item "itm_nope"/);
    await d.engine.answer(item?.id ?? "", blue);
    expect(() => d.engine.snooze(item?.id ?? "")).toThrow(/no longer open \(answered\)/);
    expect(() => d.engine.unsnooze(item?.id ?? "")).toThrow(/no longer open/);
    const outcome = await executeCommand(d.engine, { type: "item.snooze", itemId: "itm_nope" });
    expect(outcome).toMatchObject({ ok: false, fault: "client" });
    expect(Command.safeParse({ type: "item.snooze" }).success).toBe(false);
    expect(Command.safeParse({ type: "item.unsnooze", itemId: "" }).success).toBe(false);
  });

  it("answers the snooze commands with the item and its thread, as the contract says", async () => {
    const d = daemon();
    await threadAsking(d);
    const [item] = d.engine.snapshot().items;
    for (const type of ["item.snooze", "item.unsnooze"] as const) {
      const outcome = await executeCommand(d.engine, { type, itemId: item?.id ?? "" });
      if (!outcome.ok) throw new Error(outcome.error);
      expect(CommandResults[type].parse(outcome.result)).toEqual(outcome.result);
    }
  });
});

describe("Engine: error items", () => {
  /** A thread whose first turn fails, the way Claude reports an API error. */
  async function failing(d: ReturnType<typeof daemon>, prompt = "Fix the flaky test") {
    d.adapter.onStart = (session) => {
      session.onPrompt = (_prompt, turnId) => {
        session.say("Running the tests.");
        session.emit({
          type: "runtime.error",
          turnId,
          payload: { message: "API Error: 529 Overloaded" },
        });
        session.complete("failed");
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt });
    await settle();
    return thread;
  }

  it("a failed turn becomes an error card, not done: the thread needs you", async () => {
    const d = daemon();
    const thread = await failing(d);
    const [item] = d.engine.snapshot().items;
    expect(QueueItem.parse(item)).toEqual(item);
    expect(item).toMatchObject({
      threadId: thread.id,
      kind: "error",
      lane: "quick",
      ask: "Claude's turn failed",
      error: {
        cause: "turn",
        message: "API Error: 529 Overloaded",
        prompts: ["Fix the flaky test"],
      },
    });
    expect(d.engine.view(thread.id)).toMatchObject({ activity: "needs-you", working: false });
  });

  it("Retry tells the same session to check what's done and carry on, not the prompt again", async () => {
    const d = daemon();
    const thread = await failing(d);
    const [item] = d.engine.snapshot().items;
    d.adapter.last.onPrompt = undefined;
    const result = await d.engine.answer(item?.id ?? "", { kind: "error", action: "retry" });
    expect(result).toMatchObject({ delivery: "message", item: { resolution: { kind: "retried" } } });
    expect(d.adapter.sessions).toHaveLength(1);
    expect(d.adapter.last.prompts).toEqual(["Fix the flaky test", carryOn(item?.error)]);
    expect(d.adapter.last.prompts[1]).toContain("API Error: 529 Overloaded");
    expect(d.engine.snapshot().items).toEqual([]);
    expect(d.engine.view(thread.id).activity).toBe("working");
  });

  it("failing to start again and again keeps one card, which Retry empties in order", async () => {
    const adapter = new FakeAdapter();
    adapter.failWith = new Error("claude not found");
    const d = daemon(adapter);
    const thread = await d.engine.createThread({ project: "app", prompt: "one" });
    d.engine.send(thread.id, "two");
    const items = d.engine.snapshot().items;
    expect(items).toMatchObject([{ kind: "error", error: { cause: "start", prompts: ["one", "two"] } }]);
    expect(d.changes.filter((c) => c.type === "item").map((c) => c.change.type)).toEqual([
      "opened",
      "updated",
    ]);
    adapter.failWith = undefined;
    await d.engine.answer(items[0]?.id ?? "", { kind: "error", action: "retry" });
    expect(adapter.last.prompts).toEqual(["one"]);
    adapter.last.complete();
    await settle();
    expect(adapter.last.prompts).toEqual(["one", "two"]);
  });

  it("Tell it something sends your words instead; empty words are refused", async () => {
    const d = daemon();
    await failing(d);
    const [item] = d.engine.snapshot().items;
    d.adapter.last.onPrompt = undefined;
    await expect(
      d.engine.answer(item?.id ?? "", { kind: "error", action: "tell", text: "  " }),
    ).rejects.toThrow(/Say what to tell it/);
    await expect(
      d.engine.answer(item?.id ?? "", { kind: "question", answers: {} }),
    ).rejects.toThrow(/is an error; answer it with retry/);
    const result = await d.engine.answer(item?.id ?? "", {
      kind: "error",
      action: "tell",
      text: "Use the fake clock",
    });
    expect(result.item.resolution).toEqual({ kind: "told", text: "Use the fake clock" });
    expect(d.adapter.last.prompts.at(-1)).toBe("Use the fake clock");
  });

  it("Archive archives the thread, which dismisses the card; a refusal leaves both", async () => {
    const d = daemon();
    const thread = await failing(d);
    const [item] = d.engine.snapshot().items;
    writeFileSync(join(thread.worktreePath, "work.txt"), "unsaved");
    await expect(
      d.engine.answer(item?.id ?? "", { kind: "error", action: "archive" }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(d.engine.snapshot().items).toHaveLength(1);

    rmSync(join(thread.worktreePath, "work.txt"));
    const result = await d.engine.answer(item?.id ?? "", { kind: "error", action: "archive" });
    expect(result).toMatchObject({
      delivery: "archived",
      thread: { status: "archived" },
      item: { resolution: { kind: "dismissed" } },
    });
    expect(d.engine.snapshot()).toMatchObject({ items: [], threads: [] });
  });

  it("an agent that crashes mid-turn with nothing asked: Retry resumes its session, to carry on", async () => {
    const d = daemon();
    d.adapter.onStart = (session) => {
      if (d.adapter.sessions.length === 1) {
        session.onPrompt = () => session.crash("exited with code 1");
      }
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "Build it" });
    await settle();
    const [item] = d.engine.snapshot().items;
    expect(item).toMatchObject({
      kind: "error",
      ask: "Claude stopped mid-turn",
      error: { cause: "crash", message: "exited with code 1", prompts: ["Build it"] },
    });
    expect(d.engine.view(thread.id).activity).toBe("needs-you");
    const first = d.adapter.last;
    await d.engine.answer(item?.id ?? "", { kind: "error", action: "retry" });
    expect(d.adapter.last).not.toBe(first);
    expect(d.adapter.last.input.resumeSessionId).toBe(first.sessionId);
    expect(d.adapter.last.prompts).toEqual([carryOn(item?.error)]);
    expect(d.adapter.last.prompts[0]).toContain('It began with my message: "Build it"');
  });

  it("clears by itself when the thread's next turn starts (a prompt from the CLI)", async () => {
    const d = daemon();
    const thread = await failing(d);
    d.adapter.last.onPrompt = undefined;
    d.engine.send(thread.id, "Try a different approach");
    await settle();
    expect(d.engine.snapshot().items).toEqual([]);
    const resolved = d.changes.filter((c) => c.type === "item" && c.change.type === "resolved");
    expect(resolved.at(-1)).toMatchObject({
      change: { item: { resolution: { kind: "recovered" } } },
    });
  });

  it("archiving mid-turn shows no error card, not even for a moment", async () => {
    const d = daemon();
    d.adapter.onStart = (session) => {
      session.onPrompt = () => session.say("Working on it.");
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "Long job" });
    await settle();
    await d.engine.archive(thread.id);
    expect(d.changes.filter((c) => c.type === "item")).toEqual([]);
    expect(d.engine.snapshot().items).toEqual([]);
  });

  it("a refused archive after the stop picks the cut-short turn up again", async () => {
    const d = daemon();
    d.adapter.onStart = (session) => {
      session.onPrompt = () => session.say("Working on it.");
      // It writes a file as it stops: the archive's second look finds uncommitted work.
      const stop = session.stop.bind(session);
      session.stop = async () => {
        writeFileSync(join(session.input.cwd, "late.txt"), "written while stopping");
        await stop();
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "Long job" });
    await settle();
    const stopped = d.adapter.last;
    await expect(d.engine.archive(thread.id)).rejects.toThrow(/uncommitted changes/);
    expect(stopped.stopped).toBe(true);
    expect(d.engine.view(thread.id).status).toBe("active");
    expect(d.engine.snapshot().items).toEqual([]);
    expect(d.adapter.last).not.toBe(stopped);
    expect(d.adapter.last.prompts).toEqual([RESTART_PROMPT]);
  });

  it("a graceful daemon stop mid-turn: no card; the next daemon resumes the turn, once", async () => {
    const first = daemon();
    first.adapter.onStart = (session) => {
      session.onPrompt = () => session.say("Working on it.");
    };
    const thread = await first.engine.createThread({ project: "app", prompt: "Long job" });
    await settle();
    await first.engine.close();
    expect(first.changes.filter((c) => c.type === "item")).toEqual([]);

    const second = daemon();
    expect(second.engine.snapshot().items).toEqual([]);
    const resumed = second.adapter.last;
    expect(resumed.input.resumeSessionId).toBe(first.adapter.last.sessionId);
    expect(resumed.prompts).toEqual([RESTART_PROMPT]);
    expect(second.engine.view(thread.id).activity).toBe("working");
    // Restarted again, gracefully, mid-resume: that resumes again (a deliberate restart).
    await second.engine.close();
    const third = daemon();
    expect(third.adapter.last.prompts).toEqual([RESTART_PROMPT]);
    expect(third.engine.snapshot().items).toEqual([]);
  });

  it("a graceful stop with a question open resumes nothing: answering it does", async () => {
    const first = daemon();
    await threadAsking(first);
    await first.engine.close();
    const second = daemon();
    expect(second.adapter.sessions).toEqual([]);
    expect(second.engine.snapshot().items).toMatchObject([{ kind: "question", detached: true }]);
  });

  it("the resumed turn crashing is an error card", async () => {
    const first = daemon();
    first.adapter.onStart = (session) => {
      session.onPrompt = () => session.say("Working on it.");
    };
    await first.engine.createThread({ project: "app", prompt: "Long job" });
    await settle();
    await first.engine.close();
    const adapter = new FakeAdapter();
    adapter.onStart = (session) => {
      session.onPrompt = () => session.crash("Claude Code process exited with code 1");
    };
    const second = daemon(adapter);
    await settle();
    expect(second.engine.snapshot().items).toMatchObject([
      {
        kind: "error",
        ask: "Claude stopped mid-turn",
        error: { cause: "crash", message: "Claude Code process exited with code 1" },
      },
    ]);
  });

  it("a kill mid-turn resumes too, but a second kill mid-resume leaves an error card", async () => {
    const first = daemon();
    first.adapter.onStart = (session) => {
      session.onPrompt = () => session.say("Working on it.");
    };
    await first.engine.createThread({ project: "app", prompt: "Long job" });
    await settle();
    kill(first);
    const second = daemon();
    expect(second.engine.snapshot().items).toEqual([]);
    expect(second.adapter.last.prompts).toEqual([RESTART_PROMPT]);
    await settle(); // its turn.started is in the log when the kill comes
    kill(second);
    const third = daemon();
    expect(third.adapter.sessions).toEqual([]);
    expect(third.engine.snapshot().items).toMatchObject([
      {
        kind: "error",
        ask: "Claude stopped mid-turn",
        error: {
          message: "Tenzo stopped twice while this turn ran, so it wasn't resumed again.",
          prompts: [RESTART_PROMPT],
        },
      },
    ]);
  });

  it("a graceful stop resumes nothing for a turn that finished while it stopped", async () => {
    const first = daemon();
    first.adapter.onStart = (session) => {
      session.onPrompt = () => session.say("Almost done.");
      // The turn ends within the stop's grace, as Claude's does when its input closes.
      const stop = session.stop.bind(session);
      session.stop = async () => {
        session.complete();
        await stop();
      };
    };
    await first.engine.createThread({ project: "app", prompt: "Short job" });
    await settle();
    await first.engine.close();
    const second = daemon();
    expect(second.adapter.sessions).toEqual([]);
    expect(second.engine.snapshot().items).toEqual([]);
  });

  it("only an ask of the live session is waiting: open finished work, or an old detached ask, doesn't stop a resume", async () => {
    const first = daemon();
    first.adapter.onStart = (session) => {
      session.onPrompt = () => {
        session.respondToProposal(session.propose("Add a counter page."), "build");
        session.report("Added a counter page.");
        session.complete();
      };
    };
    const thread = await first.engine.createThread({ project: "app", prompt: "Add a counter" });
    await settle();
    first.adapter.onStart = undefined;
    first.adapter.last.onPrompt = () => first.adapter.last.say("Following up.");
    first.engine.send(thread.id, "One more thing");
    await settle();
    await first.engine.close();
    const second = daemon();
    expect(second.adapter.last.prompts).toEqual([RESTART_PROMPT]);
    expect(second.engine.snapshot().items).toMatchObject([{ kind: "finished" }]);
  });

  it("a crash mid-turn with finished work open still gets its error card", async () => {
    const d = daemon();
    d.adapter.onStart = (session) => {
      session.onPrompt = () => {
        session.respondToProposal(session.propose("Add a counter page."), "build");
        session.report("Added a counter page.");
        session.complete();
      };
    };
    const thread = await d.engine.createThread({ project: "app", prompt: "Add a counter" });
    await settle();
    d.adapter.onStart = undefined;
    const session = d.adapter.last;
    session.onPrompt = () => session.crash("boom");
    d.engine.send(thread.id, "One more thing");
    await settle();
    expect(d.engine.snapshot().items.map((i) => i.kind)).toEqual(["finished", "error"]);
  });

  it("a retry of a retry quotes the prompt the work began with, not the last carry-on", () => {
    const first = carryOn({ cause: "turn", message: "Overloaded", prompts: ["Fix the flaky test"] });
    const second = carryOn({ cause: "turn", message: "Overloaded again", prompts: [first] });
    expect(second).toMatch(/^Your last turn didn't finish: Overloaded again\n/);
    expect(second).toContain('It began with my message: "Fix the flaky test"');
    expect(carryOn({ cause: "crash", message: "x", prompts: [RESTART_PROMPT] })).not.toContain(
      "It began with",
    );
  });
});

describe("Engine: project config", () => {
  const repo = (d: ReturnType<typeof daemon>) => findProject(d.store, "app").path;
  function writeConfig(d: ReturnType<typeof daemon>, name: "config" | "local", value: unknown) {
    mkdirSync(join(repo(d), ".tenzo"), { recursive: true });
    writeFileSync(
      join(repo(d), ".tenzo", `${name}.json`),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  /** The session ends between turns, so the thread's next prompt starts a new one. */
  async function endSession(d: ReturnType<typeof daemon>) {
    d.adapter.last.complete();
    d.adapter.last.crash();
    await settle();
  }
  const configItems = (d: ReturnType<typeof daemon>) =>
    d.engine.snapshot().items.filter((i) => i.kind === "error" && i.error?.cause === "config");

  it("passes the config's models per phase, subagents' model and permission mode to each session", async () => {
    const d = daemon();
    writeConfig(d, "config", {
      agent: "claude",
      models: {
        discuss: { model: "haiku", thinking: "off" },
        build: { model: "sonnet", thinking: "low" },
        agents: { model: "haiku" },
      },
      permissions: "acceptEdits",
    });
    await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    expect(d.adapter.last.input).toMatchObject({
      phase: "discussing",
      models: {
        discuss: { model: "haiku", thinking: "off" },
        build: { model: "sonnet", thinking: "low" },
        agents: "haiku",
      },
      permissionMode: "acceptEdits",
    });
    expect(configItems(d)).toEqual([]);
  });

  it("reads the config again as each session starts: an edit applies without a restart", async () => {
    const d = daemon();
    writeConfig(d, "config", { models: { discuss: { model: "haiku" } } });
    const thread = await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    expect(d.adapter.last.input.models?.discuss).toEqual({ model: "haiku" });
    // Your own local.json overrides the committed file.
    writeConfig(d, "local", { models: { discuss: { thinking: "high" } }, permissions: "dontAsk" });
    await endSession(d);
    d.engine.send(thread.id, "Again");
    await settle();
    expect(d.adapter.sessions).toHaveLength(2);
    expect(d.adapter.last.input).toMatchObject({
      models: { discuss: { model: "haiku", thinking: "high" } },
      permissionMode: "dontAsk",
    });
  });

  it("with no config, a session gets no models, thinking or permission mode", async () => {
    const d = daemon();
    await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    expect(d.adapter.last.input.models).toEqual({ discuss: {}, build: {} });
    expect(d.adapter.last.input).not.toHaveProperty("permissionMode");
    expect(d.engine.snapshot().threads[0]).toMatchObject({ model: null, thinking: null, landing: "merge" });
  });

  it("TENZO_DEFAULT_MODEL fills in where the config names no model", async () => {
    const d = daemon(new FakeAdapter(), { defaultModel: "haiku" });
    writeConfig(d, "config", { models: { discuss: { model: "opus" } } });
    const thread = await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    expect(d.adapter.last.input.models).toEqual({ discuss: { model: "opus" }, build: { model: "haiku" } });
    // The default is not the thread's own: it isn't stored on it.
    expect(thread.model).toBeNull();
  });

  it("an invalid config is a clear error card, and the thread runs on the defaults meanwhile", async () => {
    const d = daemon();
    writeConfig(d, "config", { models: { build: { thinking: "max" } } });
    const thread = await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    // The thread went on: its prompt was sent, on the agent's own defaults.
    expect(d.adapter.last.prompts).toEqual(["Go"]);
    expect(d.adapter.last.input.models).toEqual({ discuss: {}, build: {} });
    const [card, ...more] = configItems(d);
    expect(more).toEqual([]);
    expect(QueueItem.parse(card)).toEqual(card);
    expect(card).toMatchObject({
      threadId: thread.id,
      lane: "quick",
      ask: "The project's Tenzo config is invalid",
      error: { cause: "config", prompts: [] },
    });
    expect(card?.error?.message).toMatch(/^\.tenzo\/config\.json: models\.build\.thinking: /);

    // Still wrong at the next session: still the one card.
    await endSession(d);
    d.engine.send(thread.id, "Again");
    await settle();
    expect(configItems(d).map((i) => i.id)).toEqual([card?.id]);

    // Wrong another way: the card says what is wrong now.
    writeConfig(d, "config", "{");
    await endSession(d);
    d.engine.send(thread.id, "Once more");
    await settle();
    const [now] = configItems(d);
    expect(now?.id).not.toBe(card?.id);
    expect(now?.error?.message).toMatch(/isn't valid JSON/);

    // Fixed: the card goes by itself at the next session.
    writeConfig(d, "config", { models: { build: { thinking: "high" } } });
    await endSession(d);
    d.engine.send(thread.id, "Fixed");
    await settle();
    expect(configItems(d)).toEqual([]);
    expect(d.adapter.last.input.models).toEqual({ discuss: {}, build: { thinking: "high" } });
    const recovered = d.engine
      .events(thread.id)
      .events.filter((e) => e.event.type === "config.checked")
      .map((e) => (e.event.type === "config.checked" ? e.event.payload.problem : undefined));
    expect(recovered.at(-1)).toBeNull();
  });

  it("Retry on a config card reads the config again and sends the agent nothing", async () => {
    const d = daemon();
    writeConfig(d, "config", { landing: "squash" });
    await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    const [card] = configItems(d);

    // Not fixed yet: a new card, still saying what is wrong.
    const again = await d.engine.answer(card?.id ?? "", { kind: "error", action: "retry" });
    expect(again).toMatchObject({ delivery: "none", item: { resolution: { kind: "retried" } } });
    const [next] = configItems(d);
    expect(next?.id).not.toBe(card?.id);
    expect(next?.error?.message).toMatch(/landing: /);

    writeConfig(d, "config", { landing: "pr", models: { discuss: { model: "haiku" } } });
    await d.engine.answer(next?.id ?? "", { kind: "error", action: "retry" });
    await settle();
    expect(configItems(d)).toEqual([]);
    // The running session took the fixed config's models at once; no prompt went.
    expect(d.adapter.last.modelChanges.at(-1)).toEqual({ discuss: { model: "haiku" }, build: {} });
    expect(d.adapter.last.prompts).toEqual(["Go"]);
    expect(d.adapter.sessions).toHaveLength(1);
    expect(d.engine.snapshot().threads[0]?.landing).toBe("pr");
  });

  it("a config card survives the thread's next turn: only a fixed config clears it", async () => {
    const d = daemon();
    writeConfig(d, "config", { agent: "codex" });
    const thread = await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    d.adapter.last.complete();
    d.engine.send(thread.id, "Next");
    await settle();
    expect(d.adapter.last.prompts).toEqual(["Go", "Next"]);
    expect(configItems(d)).toHaveLength(1);
  });

  it("carries the project's landing rule on every thread view, read again when it changes", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", title: "Quiet" });
    expect(thread.landing).toBe("merge");
    writeConfig(d, "config", { landing: "pr" });
    expect(d.engine.view(thread.id).landing).toBe("pr");
    expect(ThreadView.parse(d.engine.snapshot().threads[0])).toMatchObject({ landing: "pr" });
    writeConfig(d, "local", { landing: "merge" });
    expect(d.engine.view(thread.id).landing).toBe("merge");
    // An invalid config lands the default way.
    writeConfig(d, "local", "nope");
    expect(d.engine.view(thread.id).landing).toBe("merge");
  });
});

describe("Engine: a thread's own model (thread.setModel)", () => {
  function writeConfig(d: ReturnType<typeof daemon>, value: unknown) {
    const root = findProject(d.store, "app").path;
    mkdirSync(join(root, ".tenzo"), { recursive: true });
    writeFileSync(join(root, ".tenzo", "config.json"), JSON.stringify(value));
  }

  it("sets the thread's model over the project's config, persisted, and switches the running session", async () => {
    const d = daemon();
    writeConfig(d, { models: { discuss: { model: "haiku" }, build: { model: "sonnet", thinking: "low" }, agents: { model: "haiku" } } });
    const thread = await d.engine.createThread({ project: "app", prompt: "Go" });
    await settle();
    const command = Command.parse({ type: "thread.setModel", threadId: thread.id, model: "opus", thinking: "high" });
    const outcome = await executeCommand(d.engine, command);
    expect(outcome.ok).toBe(true);
    const { thread: view } = CommandResults["thread.setModel"].parse(outcome.ok ? outcome.result : null);
    expect(view).toMatchObject({ model: "opus", thinking: "high" });
    expect(d.adapter.last.modelChanges).toEqual([
      { discuss: { model: "opus", thinking: "high" }, build: { model: "opus", thinking: "high" }, agents: "haiku" },
    ]);

    // Kept across a restart, and the next session starts with it.
    kill(d);
    const next = daemon();
    expect(next.engine.view(thread.id)).toMatchObject({ model: "opus", thinking: "high" });
    next.engine.send(thread.id, "Again");
    await settle();
    expect(next.adapter.last.input.models?.discuss).toEqual({ model: "opus", thinking: "high" });

    // Cleared: the project's config decides again.
    next.engine.setModel(thread.id, { model: null });
    expect(next.engine.view(thread.id)).toMatchObject({ model: null, thinking: null });
    expect(next.adapter.last.modelChanges.at(-1)).toEqual({
      discuss: { model: "haiku" },
      build: { model: "sonnet", thinking: "low" },
      agents: "haiku",
    });
  });

  it("a thinking level alone keeps the config's models", async () => {
    const d = daemon();
    writeConfig(d, { models: { build: { model: "sonnet" } } });
    const thread = await d.engine.createThread({ project: "app", title: "Idle" });
    const view = d.engine.setModel(thread.id, { model: null, thinking: "off" });
    expect(view).toMatchObject({ model: null, thinking: "off" });
    d.engine.send(thread.id, "Go");
    await settle();
    expect(d.adapter.last.input.models).toEqual({ discuss: { thinking: "off" }, build: { model: "sonnet", thinking: "off" } });
  });

  it("refuses an archived thread, and a model that is only spaces", async () => {
    const d = daemon();
    const thread = await d.engine.createThread({ project: "app", title: "Gone" });
    expect(Command.safeParse({ type: "thread.setModel", threadId: thread.id, model: "  " }).success).toBe(false);
    expect(Command.safeParse({ type: "thread.setModel", threadId: thread.id, model: "x", thinking: "max" }).success).toBe(false);
    await d.engine.archive(thread.id);
    expect(() => d.engine.setModel(thread.id, { model: "opus" })).toThrow(/archived/);
  });
});
