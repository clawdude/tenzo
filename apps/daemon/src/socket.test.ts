import { join } from "node:path";
import { ServerFrame, type UserInputQuestion } from "@tenzo/contracts";
import type { WSContext } from "hono/ws";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { FakeAdapter } from "./agent/fake-agent.ts";
import type { Engine } from "./engine.ts";
import { addProject } from "./projects.ts";
import { type RunningDaemon, startDaemon } from "./server.ts";
import { socketHandlers } from "./socket.ts";
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

async function start(heartbeatMs?: number): Promise<RunningDaemon> {
  const daemon = await startDaemon(
    {
      host: "127.0.0.1",
      port: 0,
      home,
      webDir: join(home, "web"),
      allowedHosts: [],
      devOrigins: [],
    },
    { adapters: { claude: adapter }, ...(heartbeatMs ? { heartbeatMs } : {}) },
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
