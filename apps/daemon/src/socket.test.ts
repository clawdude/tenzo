import { join } from "node:path";
import { ServerFrame, type UserInputQuestion } from "@tenzo/contracts";
import type { WSContext } from "hono/ws";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { executeCommand } from "./commands.ts";
import type { Engine, EngineChange } from "./engine.ts";
import { addProject } from "./projects.ts";
import { type DaemonDeps, type RunningDaemon, startDaemon } from "./server.ts";
import { MAX_WATCHED, socketHandlers } from "./socket.ts";
import { openStore } from "./store.ts";
import { initRepo, removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

const color: UserInputQuestion = {
  id: "Which color?",
  header: "",
  question: "Which color?",
  options: [
    { label: "Red", value: "Red", description: "", recommended: true },
    { label: "Blue", value: "Blue", description: "", recommended: false },
  ],
  multiSelect: false,
};

let home: string;
let adapter: FakeAdapter;
const running: RunningDaemon[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  home = join(tempDir("home"), ".tenzo");
  const store = openStore(home);
  await addProject(store, initRepo("app"));
  store.close();
  adapter = new FakeAdapter();
  // On its prompt, the agent says a line and asks the color.
  adapter.onStart = (session) => {
    session.onPrompt = () => {
      session.say("Before I paint:");
      session.ask([color]);
    };
  };
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await Promise.all(running.splice(0).map((d) => d.close()));
});

async function start(heartbeatMs?: number, deps: DaemonDeps = {}): Promise<RunningDaemon> {
  const daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      home,
      webDir: join(home, "web"),
      allowedHosts: [],
      devOrigins: [],
    },
    { adapters: { claude: adapter }, ...(heartbeatMs ? { heartbeatMs } : {}), ...deps },
  );
  running.push(daemon);
  return daemon;
}

/** A WebSocket client that keeps every frame it gets, validated, and can wait for one. */
class Client {
  readonly frames: ServerFrame[] = [];
  readonly #waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] =
    [];
  #nextId = 1;
  readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const frame = ServerFrame.parse(JSON.parse(String(data)));
      this.frames.push(frame);
      for (const w of [...this.#waiters]) {
        if (w.match(frame)) {
          this.#waiters.splice(this.#waiters.indexOf(w), 1);
          w.resolve(frame);
        }
      }
    });
  }

  static async open(daemon: RunningDaemon, options?: ConstructorParameters<typeof WebSocket>[2]) {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, options);
    const client = new Client(ws);
    clients.push(client);
    await client.next((f) => f.type === "snapshot");
    return client;
  }

  /** The first frame matching, already received or still to come. */
  next<T extends ServerFrame>(match: (f: ServerFrame) => f is T): Promise<T>;
  next(match: (f: ServerFrame) => boolean): Promise<ServerFrame>;
  next(match: (f: ServerFrame) => boolean): Promise<ServerFrame> {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve) => this.#waiters.push({ match, resolve }));
  }

  send(frame: unknown): void {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  /** Sends a command and waits for its `ok` or `error`. */
  async command(command: unknown): Promise<ServerFrame> {
    const id = `c${this.#nextId++}`;
    this.send({ type: "command", id, command });
    return this.next((f) => (f.type === "ok" || f.type === "error") && f.id === id);
  }
}

const isItem = (change: string) => (f: ServerFrame) => f.type === "item" && f.change === change;
const d = (daemon: RunningDaemon) => daemon.engine;

describe("/ws", () => {
  it("says hello, then sends a snapshot of threads and open items", async () => {
    const daemon = await start();
    const first = await Client.open(daemon);
    expect(first.frames.map((f) => f.type)).toEqual(["hello", "snapshot"]);
    expect(first.frames[1]).toMatchObject({
      snapshot: { environmentId: daemon.environmentId, threads: [], items: [] },
    });

    await first.command({ type: "thread.create", project: "app", prompt: "Paint it" });
    await first.next(isItem("opened"));
    const later = await Client.open(daemon);
    const snapshot = later.frames[1];
    expect(snapshot?.type === "snapshot" && snapshot.snapshot).toMatchObject({
      threads: [{ title: "Paint it", activity: "needs-you" }],
      items: [{ ask: "Which color?", context: "Before I paint:", status: "open" }],
    });
  });

  it("offers the projects: in the snapshot, and fresh on request", async () => {
    const daemon = await start();
    const client = await Client.open(daemon);
    const snapshot = client.frames[1];
    expect(snapshot?.type === "snapshot" && snapshot.snapshot.projects).toEqual([
      expect.objectContaining({ name: "app", defaultBranch: "main" }),
    ]);
    // `tenzo project add` writes the database from another process while the daemon runs.
    const store = openStore(home);
    await addProject(store, initRepo("blog"));
    store.close();
    const listed = await client.command({ type: "project.list" });
    expect(listed.type === "ok" && listed.result).toEqual({
      projects: [
        expect.objectContaining({ name: "app" }),
        expect.objectContaining({ name: "blog" }),
      ],
    });
  });

  it("renames a new thread once its name is ready, and tells every client", async () => {
    let name: (title: string) => void = () => {};
    const daemon = await start(undefined, {
      titler: () => new Promise((resolve) => (name = resolve)),
    });
    const client = await Client.open(daemon);
    const created = await client.command({
      type: "thread.create",
      project: "app",
      prompt: "Paint the fence a colour of my choosing",
    });
    expect(created.type === "ok" && created.result).toMatchObject({
      thread: { title: "Paint the fence a…" },
    });
    name("Fence colour");
    const renamed = await client.next(
      (f) => f.type === "thread" && f.thread.title === "Fence colour",
    );
    expect(renamed).toMatchObject({ thread: { title: "Fence colour" } });
  });

  it("streams the same changes to every client, and runs commands from any of them", async () => {
    const daemon = await start();
    const a = await Client.open(daemon);
    const b = await Client.open(daemon);

    const created = await a.command({ type: "thread.create", project: "app", prompt: "Paint it" });
    expect(created).toMatchObject({ type: "ok", result: { thread: { title: "Paint it" } } });
    for (const c of [a, b]) {
      await c.next((f) => f.type === "thread" && f.thread.title === "Paint it");
    }
    const [openedA, openedB] = await Promise.all([a.next(isItem("opened")), b.next(isItem("opened"))]);
    expect(openedA).toEqual(openedB);
    if (openedB.type !== "item") throw new Error("not an item");

    const answered = await b.command({
      type: "item.answer",
      itemId: openedB.item.id,
      answer: { kind: "question", answers: { "Which color?": "Blue" } },
    });
    expect(answered).toMatchObject({ type: "ok", result: { delivery: "live" } });
    for (const c of [a, b]) {
      const resolved = await c.next(isItem("resolved"));
      expect(resolved).toMatchObject({ item: { id: openedB.item.id, status: "resolved" } });
    }
    // The change reached the client that answered before its answer did.
    const index = (f: ServerFrame) => b.frames.indexOf(f);
    expect(index(await b.next(isItem("resolved")))).toBeLessThan(index(answered));
    expect(adapter.last.answered).toMatchObject([{ answers: { "Which color?": "Blue" } }]);
  });

  it("answers a failed command with an error carrying its id", async () => {
    const daemon = await start();
    const c = await Client.open(daemon);
    const unknown = await c.command({ type: "thread.send", threadId: "thr_nope", prompt: "hi" });
    expect(unknown).toMatchObject({ type: "error", error: expect.stringMatching(/No thread "thr_nope"/) });
    const malformed = await c.command({ type: "thread.send", threadId: "thr_x", prompt: "" });
    expect(malformed).toMatchObject({ type: "error", error: expect.stringMatching(/^Not a frame/) });
    const unheard = await c.command({ type: "thread.delete" });
    expect(unheard).toMatchObject({ type: "error" });
  });

  it("rejects frames it can't read without dropping the socket", async () => {
    const daemon = await start();
    const c = await Client.open(daemon);
    c.send("not json");
    c.send({ type: "nope" });
    c.send(Buffer.from([1, 2, 3]));
    await expect.poll(() => c.frames.filter((f) => f.type === "error")).toHaveLength(3);
    expect(c.frames.filter((f) => f.type === "error").map((f) => "id" in f && f.id)).toEqual([
      null,
      null,
      null,
    ]);
    c.send({ type: "ping", at: "now" });
    await c.next((f) => f.type === "pong");
  });

  it("drops a client that stops answering pings", async () => {
    const daemon = await start(50);
    const silent = await Client.open(daemon, { autoPong: false });
    const live = await Client.open(daemon);
    const closed = new Promise<void>((resolve) => silent.ws.on("close", () => resolve()));
    await closed;
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("makes one thread for a thread.create sent twice under one client key, from any client", async () => {
    const daemon = await start();
    const a = await Client.open(daemon);
    const create = {
      type: "thread.create",
      project: "app",
      prompt: "Paint it",
      clientKey: "key-socket-01",
    } as const;
    const first = await a.command(create);
    a.ws.terminate(); // the answer may have been lost: the client reconnects and retries
    const b = await Client.open(daemon);
    const second = await b.command(create);
    const id = (answer: typeof first) => answer.type === "ok" && (answer.result as { thread: { id: string } }).thread.id;
    expect(first).toMatchObject({ type: "ok", result: { thread: { title: "Paint it" } } });
    expect(id(second)).toBe(id(first));
    const listed = await b.command({ type: "snapshot" });
    expect(listed.type === "ok" && listed.result).toMatchObject({ threads: [{ title: "Paint it" }] });
    expect(listed.type === "ok" && (listed.result as { threads: unknown[] }).threads).toHaveLength(1);

    const reused = await b.command({ ...create, prompt: "Paint it red" });
    expect(reused).toMatchObject({
      type: "error",
      error: expect.stringMatching(/already used for another thread\.create/),
    });
  });

  it("stops sending to a client once it has gone", async () => {
    const daemon = await start();
    const gone = await Client.open(daemon);
    gone.ws.close();
    await new Promise<void>((resolve) => gone.ws.on("close", () => resolve()));
    const stays = await Client.open(daemon);
    await stays.command({ type: "thread.create", project: "app", prompt: "Paint it" });
    await stays.next(isItem("opened"));
    expect(gone.frames.map((f) => f.type)).toEqual(["hello", "snapshot"]);
  });
});

describe("thread.watch", () => {
  type Stored = { seq: number; event: { type: string; threadId: string } };
  const eventsOf = (c: Client, threadId: string): Stored[] =>
    c.frames.flatMap((f) => (f.type === "event" && f.event.event.threadId === threadId ? [f.event] : []));
  const okResult = <T>(frame: ServerFrame): T => {
    if (frame.type !== "ok") throw new Error(`not ok: ${JSON.stringify(frame)}`);
    return frame.result as T;
  };
  type Backlog = { events: Stored[]; older: boolean; reset: boolean; thread: { id: string } };

  /** A thread whose agent has said its line and asked; returns its id. */
  async function asking(c: Client): Promise<string> {
    const created = okResult<{ thread: { id: string } }>(
      await c.command({ type: "thread.create", project: "app", prompt: "Paint it" }),
    );
    await c.next(isItem("opened"));
    return created.thread.id;
  }

  it("answers with the backlog, then streams each new event once, in order", async () => {
    const daemon = await start();
    const c = await Client.open(daemon);
    const threadId = await asking(c);
    const watched = await c.command({ type: "thread.watch", threadId });
    const backlog = okResult<Backlog>(watched);
    expect(backlog.reset).toBe(true);
    expect(backlog.older).toBe(false);
    expect(backlog.events.map((e) => e.event.type)).toEqual([
      "session.started",
      "turn.started",
      "item.completed",
      "user-input.requested",
    ]);
    expect(eventsOf(c, threadId)).toEqual([]); // nothing before the answer

    const opened = await c.next(isItem("opened"));
    if (opened.type !== "item") throw new Error("not an item");
    await c.command({
      type: "item.answer",
      itemId: opened.item.id,
      answer: { kind: "question", answers: { "Which color?": "Blue" } },
    });
    adapter.last.say("Blue it is.");
    adapter.last.complete();
    await expect.poll(() => eventsOf(c, threadId).map((e) => e.event.type)).toEqual([
      "user-input.resolved",
      "item.completed",
      "turn.completed",
    ]);
    // Every event frame came after the watch's answer, and they follow on from the backlog.
    const frames = c.frames;
    const answerAt = frames.indexOf(watched);
    expect(frames.findIndex((f) => f.type === "event")).toBeGreaterThan(answerAt);
    const all = [...backlog.events, ...eventsOf(c, threadId)].map((e) => e.seq);
    const { events } = d(daemon).events(threadId);
    expect(all).toEqual(events.map((e) => e.seq));
  });

  it("misses nothing and repeats nothing when the agent is busy as the watch starts", async () => {
    const daemon = await start();
    const c = await Client.open(daemon);
    const threadId = await asking(c);
    const session = adapter.last;
    let said = 0;
    const chatter = setInterval(() => session.say(`line ${said++}`), 1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const backlog = okResult<Backlog>(await c.command({ type: "thread.watch", threadId }));
      await new Promise((resolve) => setTimeout(resolve, 25));
      clearInterval(chatter);
      const final = said;
      await expect
        .poll(() => d(daemon).events(threadId).events.filter((e) => e.event.type === "item.completed").length)
        .toBe(final + 1);
      await expect
        .poll(() => [...backlog.events, ...eventsOf(c, threadId)].length)
        .toBe(d(daemon).events(threadId).events.length);
      const seqs = [...backlog.events, ...eventsOf(c, threadId)].map((e) => e.seq);
      expect(seqs).toEqual(d(daemon).events(threadId).events.map((e) => e.seq));
      expect(eventsOf(c, threadId).length).toBeGreaterThan(0);
    } finally {
      clearInterval(chatter);
    }
  });

  it("stops after thread.unwatch, and only sends the watched thread's events", async () => {
    const daemon = await start();
    const c = await Client.open(daemon);
    const watchedId = await asking(c);
    const watchedSession = adapter.last;
    const otherId = okResult<{ thread: { id: string } }>(
      await c.command({ type: "thread.create", project: "app", prompt: "Other" }),
    ).thread.id;
    await expect.poll(() => adapter.sessions.length).toBe(2);
    const otherSession = adapter.last;
    okResult(await c.command({ type: "thread.watch", threadId: watchedId }));
    otherSession.say("not for you");
    watchedSession.say("for you");
    await expect.poll(() => eventsOf(c, watchedId).length).toBe(1);
    expect(eventsOf(c, otherId)).toEqual([]);

    expect(okResult(await c.command({ type: "thread.unwatch", threadId: watchedId }))).toEqual({
      watching: false,
    });
    watchedSession.say("too late");
    // A frame the daemon sends later (a command's answer) proves nothing more was sent meanwhile.
    await c.command({ type: "snapshot" });
    expect(eventsOf(c, watchedId)).toHaveLength(1);
  });

  it("re-watches after a reconnect from where the client was, or afresh after a long gap", async () => {
    const daemon = await start();
    const first = await Client.open(daemon);
    const threadId = await asking(first);
    const backlog = okResult<Backlog>(await first.command({ type: "thread.watch", threadId }));
    const had = backlog.events.at(-1)?.seq ?? 0;
    first.ws.terminate();
    adapter.last.say("while you were away");
    adapter.last.say("and this");

    const again = await Client.open(daemon);
    const caught = okResult<Backlog>(await again.command({ type: "thread.watch", threadId, after: had }));
    expect(caught.reset).toBe(false);
    expect(caught.events.map((e) => (e.event as { payload?: { text?: string } }).payload?.text)).toEqual([
      "while you were away",
      "and this",
    ]);

    // Further behind than the limit: the latest events, replacing what the client had.
    const fresh = okResult<Backlog>(
      await again.command({ type: "thread.watch", threadId, after: 0, limit: 2 }),
    );
    expect(fresh.reset).toBe(true);
    expect(fresh.older).toBe(true);
    expect(fresh.events.map((e) => e.seq)).toEqual(
      d(daemon).events(threadId).events.slice(-2).map((e) => e.seq),
    );
  });

  it("refuses an unknown thread and the HTTP transport; a thread watched twice is one watch", async () => {
    const daemon = await start();
    const c = await Client.open(daemon);
    expect(await c.command({ type: "thread.watch", threadId: "thr_nope" })).toMatchObject({
      type: "error",
      error: expect.stringMatching(/No thread "thr_nope"/),
    });
    const threadId = await asking(c);
    for (let i = 0; i < MAX_WATCHED; i++) {
      // Watching the same thread again is fine; it is one watch.
      okResult(await c.command({ type: "thread.watch", threadId }));
    }
    const outcome = await executeCommand(daemon.engine, { type: "thread.watch", threadId });
    expect(outcome).toMatchObject({ ok: false, error: expect.stringMatching(/WebSocket only/) });
  });
});

describe("socketHandlers watches", () => {
  it("caps the threads one socket watches, and forgets them all when it closes", () => {
    let listener: ((change: EngineChange) => void) | undefined;
    let unsubscribed = 0;
    const view = (id: string) => ({ id });
    const engine = {
      snapshot: () => ({ environmentId: "env_abcdefghij0123456789", threads: [], items: [], projects: [], live: null }),
      subscribe: (l: (change: EngineChange) => void) => {
        listener = l;
        return () => {
          unsubscribed++;
          listener = undefined;
        };
      },
      backlog: (threadId: string) => ({ thread: view(threadId), events: [], older: false, reset: true }),
    } as unknown as Engine;
    const handlers = socketHandlers({
      environmentId: "env_abcdefghij0123456789",
      version: "0.0.0",
      engine,
      log: () => {},
    });
    const sent: ServerFrame[] = [];
    const ws = {
      readyState: 1,
      send: (data: string) => sent.push(JSON.parse(data)),
      close: () => {},
      raw: undefined,
    } as unknown as WSContext;
    handlers.onOpen?.(new Event("open"), ws);
    const message = (frame: unknown) =>
      handlers.onMessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }), ws);
    const tid = (i: number) => `thr_${String(i).padStart(20, "0")}`;
    for (let i = 0; i <= MAX_WATCHED; i++) {
      message({ type: "command", id: `w${i}`, command: { type: "thread.watch", threadId: tid(i) } });
    }
    const answers = sent.filter((f) => f.type === "ok" || f.type === "error");
    expect(answers.slice(0, MAX_WATCHED).every((f) => f.type === "ok")).toBe(true);
    expect(answers.at(-1)).toMatchObject({ type: "error", error: expect.stringMatching(/at most/) });

    const event = (threadId: string, seq: number) =>
      ({
        type: "event",
        seq,
        environmentId: "env_abcdefghij0123456789",
        event: {
          type: "thread.archived",
          eventId: `evt_${String(seq).padStart(20, "0")}`,
          threadId,
          agent: "claude",
          createdAt: new Date(0).toISOString(),
          payload: {},
        },
      }) as EngineChange;
    listener?.(event(tid(0), 1));
    listener?.(event(tid(MAX_WATCHED), 2)); // the refused one
    expect(sent.filter((f) => f.type === "event")).toHaveLength(1);

    handlers.onClose?.(new Event("close") as Parameters<NonNullable<typeof handlers.onClose>>[0], ws);
    expect(unsubscribed).toBe(1);
    expect(listener).toBeUndefined();
  });
});

describe("socketHandlers", () => {
  it("logs, rather than crashes on, an answer that can't be sent", async () => {
    const logged: string[] = [];
    // A result JSON can't serialise: sending the answer throws after the command ran.
    const engine = {
      snapshot: () => ({ environmentId: "env_abcdefghij0123456789", threads: [], items: [1n] }),
    } as unknown as Engine;
    const handlers = socketHandlers({
      environmentId: "env_abcdefghij0123456789",
      version: "0.0.0",
      engine,
      log: (message) => logged.push(message),
    });
    const ws = { readyState: 1, send: () => {}, close: () => {}, raw: undefined };
    const frame = { type: "command", id: "7", command: { type: "snapshot" } };
    handlers.onMessage?.(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
      ws as unknown as WSContext,
    );
    await vi.waitFor(() => expect(logged).toHaveLength(1));
    expect(logged[0]).toMatch(/^couldn't answer command 7: TypeError/);
  });
});
