import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Health, ServerFrame } from "@tenzo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { VERSION } from "./app.ts";
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

async function start(): Promise<RunningDaemon> {
  const daemon = await startDaemon({ host: "127.0.0.1", port: 0, home, webDir: join(home, "web") });
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
    const { ws, frames: got } = await frames(`ws://127.0.0.1:${daemon.port}/ws`, 2, (socket) =>
      socket.send(JSON.stringify({ type: "ping", at: "now" })),
    );
    ws.close();
    expect(got.map((f) => f.type)).toEqual(["hello", "pong"]);
  });

  it("keeps the environment id across restarts", async () => {
    const first = await start();
    const id = first.environmentId;
    await first.close();
    running.splice(0);
    const second = await start();
    expect(second.environmentId).toBe(id);
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
