import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health, ServerFrame } from "@tenzo/contracts";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { FakeAdapter } from "./agent/fake-agent.ts";
import { VERSION } from "./app.ts";
import { callDaemon } from "./client.ts";
import { addProject } from "./projects.ts";
import { openStore } from "./store.ts";
import { initRepo, pairDevice, removeTempDirs } from "./testing.ts";

afterAll(removeTempDirs);
import { type RunningDaemon, startDaemon } from "./server.ts";

let home: string;
const running: RunningDaemon[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tenzo-home-"));
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((d) => d.close()));
  rmSync(home, { recursive: true, force: true });
});

const config = (dir: string) => ({
  host: "127.0.0.1" as const,
  port: 0,
  home: dir,
  webDir: join(dir, "web"),
  allowedHosts: [],
  devOrigins: [],
});

async function start(): Promise<RunningDaemon> {
  const daemon = await startDaemon(config(home), { adapters: { claude: new FakeAdapter() } });
  running.push(daemon);
  return daemon;
}

/** Opens a socket and collects parsed frames until `count` arrived. */
function frames(url: string, count: number, onOpen?: (ws: WebSocket) => void) {
  return new Promise<{ ws: WebSocket; frames: ServerFrame[] }>((resolve, reject) => {
    const ws = new WebSocket(url);
    const got: ServerFrame[] = [];
    ws.on("open", () => onOpen?.(ws));
    ws.on("message", (data) => {
      got.push(ServerFrame.parse(JSON.parse(String(data))));
      if (got.length === count) resolve({ ws, frames: got });
    });
    ws.on("error", reject);
  });
}

describe("startDaemon", () => {
  it("serves /health with the persisted environment id", async () => {
    const daemon = await start();
    const health = Health.parse(await (await fetch(`${daemon.url}/health`)).json());
    expect(health).toEqual({ ok: true, version: VERSION, environmentId: daemon.environmentId });
  });

  it("sends a hello frame on /ws", async () => {
    const daemon = await start();
    const { ws, frames: got } = await frames(`ws://127.0.0.1:${daemon.port}/ws`, 1);
    ws.close();
    const [hello] = got;
    expect(hello?.type).toBe("hello");
    if (hello?.type !== "hello") return;
    expect(hello.environmentId).toBe(daemon.environmentId);
    expect(hello.version).toBe(VERSION);
    expect(Date.parse(hello.serverTime)).not.toBeNaN();
  });

  it("answers ping with pong", async () => {
    const daemon = await start();
    const { ws, frames: got } = await frames(`ws://127.0.0.1:${daemon.port}/ws`, 3, (socket) =>
      socket.send(JSON.stringify({ type: "ping", at: "now" })),
    );
    ws.close();
    expect(got.map((f) => f.type)).toEqual(["hello", "snapshot", "pong"]);
  });

  it("keeps the environment id across restarts", async () => {
    const first = await start();
    const id = first.environmentId;
    await first.close();
    running.splice(0);
    const second = await start();
    expect(second.environmentId).toBe(id);
  });

  it("says plainly when the port is taken", async () => {
    const first = await start();
    const otherHome = mkdtempSync(join(tmpdir(), "tenzo-home-"));
    try {
      await expect(
        startDaemon({ ...config(otherHome), port: first.port }, { adapters: { claude: new FakeAdapter() } }),
      ).rejects.toThrow(new RegExp(`127.0.0.1:${first.port} is already in use`));
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
    // The first daemon is unaffected.
    expect((await fetch(`${first.url}/health`)).status).toBe(200);
  });

  it("runs one daemon per TENZO_HOME", async () => {
    await start();
    await expect(start()).rejects.toThrow(/Another tenzo daemon \(pid \d+\) is running/);
  });

  it("upgrades /ws for the Tailscale Serve page on :8443, as Serve forwards it", async () => {
    const ts = "andreas-mac-mini.tail6259b4.ts.net";
    const daemon = await startDaemon(
      { ...config(home), allowedHosts: [ts] },
      { adapters: { claude: new FakeAdapter() } },
    );
    running.push(daemon);
    const { cookie } = pairDevice(daemon.devices);
    const status = (origin: string, headers: Record<string, string> = { Cookie: cookie }) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`, {
          headers: {
            Host: `${ts}:8443`,
            "X-Forwarded-Host": `${ts}:8443`,
            "X-Forwarded-For": "100.101.102.103",
            Origin: origin,
            ...headers,
          },
        });
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", reject);
      });
    expect(await status(`https://${ts}:8443`)).toBe(101);
    expect(await status(`https://${ts}:9443`)).toBe(403);
    expect(await status(`http://${ts}:8443`)).toBe(403);
    // From the tailnet, only a paired device gets a socket.
    expect(await status(`https://${ts}:8443`, {})).toBe(401);
    expect(await status(`https://${ts}:8443`, { Cookie: "__Host-tenzo=forged" })).toBe(401);
  });

  it("refuses WebSocket upgrades from another origin or host", async () => {
    const daemon = await start();
    const url = `ws://127.0.0.1:${daemon.port}/ws`;
    const status = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(url, { headers });
        ws.on("open", () => {
          ws.close();
          resolve(101);
        });
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("error", reject);
      });
    expect(await status({ Origin: "https://evil.example" })).toBe(403);
    expect(await status({ Origin: "null" })).toBe(403);
    expect(await status({ Host: "evil.example" })).toBe(403);
    // Another localhost page (someone else's dev server) gets no socket: no preflight to save us.
    expect(await status({ Origin: "http://localhost:3000" })).toBe(403);
    expect(await status({ Origin: "http://localhost:5173" })).toBe(403);
    expect(await status({ Origin: `http://127.0.0.1:${daemon.port}` })).toBe(101);
    expect(await status({})).toBe(101);
  });

  it("runs commands from the CLI over HTTP, and open items survive a restart", async () => {
    const repo = initRepo("app");
    const setup = openStore(home);
    await addProject(setup, repo);
    setup.close();

    const asking = () => {
      const adapter = new FakeAdapter();
      adapter.onStart = (s) => {
        s.onPrompt = () => {
          s.say("Before I paint:");
          s.ask([
            {
              id: "Which color?",
              header: "",
              question: "Which color?",
              options: [
                { label: "Red", value: "Red", description: "", recommended: true },
                { label: "Blue", value: "Blue", description: "", recommended: false },
              ],
              multiSelect: false,
            },
          ]);
        };
      };
      return adapter;
    };
    const firstAdapter = asking();
    const first = await startDaemon(config(home), { adapters: { claude: firstAdapter } });
    running.push(first);
    const client = { host: "127.0.0.1", port: first.port } as const;

    const { thread } = await callDaemon(client, {
      type: "thread.create",
      project: "app",
      prompt: "Paint it",
    });
    await expect.poll(async () => (await callDaemon(client, { type: "snapshot" })).items).toHaveLength(1);
    const [item] = (await callDaemon(client, { type: "snapshot" })).items;
    expect(item).toMatchObject({ threadId: thread.id, context: "Before I paint:", suggested: "Red" });
    await expect(
      callDaemon(client, { type: "thread.send", threadId: "thr_nope", prompt: "x" }),
    ).rejects.toThrow(/No thread "thr_nope"/);

    await first.close();
    running.splice(0);
    const secondAdapter = asking();
    const second = await startDaemon(config(home), { adapters: { claude: secondAdapter } });
    running.push(second);
    const again = { host: "127.0.0.1", port: second.port } as const;
    const { items } = await callDaemon(again, { type: "snapshot" });
    expect(items).toMatchObject([{ id: item?.id, status: "open", detached: true }]);

    const answered = await callDaemon(again, {
      type: "item.answer",
      itemId: item?.id ?? "",
      answer: { kind: "question", answers: { "Which color?": "Blue" } },
    });
    expect(answered.delivery).toBe("message");
    expect(secondAdapter.last.input.resumeSessionId).toBe(firstAdapter.last.sessionId);
    expect(secondAdapter.last.prompts[0]).toContain("My answer: Blue");
  });

  it("drops open sockets on close so clients notice", async () => {
    const daemon = await start();
    const { ws } = await frames(`ws://127.0.0.1:${daemon.port}/ws`, 1);
    const closed = new Promise<void>((resolve) => ws.on("close", () => resolve()));
    await daemon.close();
    running.splice(0);
    await closed;
  });
});
