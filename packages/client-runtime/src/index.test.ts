import { describe, expect, it } from "vitest";
import { Connection, type ConnectionSnapshot } from "./index.ts";

/** A hand-driven WebSocket double: tests open, message and close it explicitly. */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  serverOpens() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  serverSends(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverDrops() {
    this.readyState = 3;
    this.onclose?.();
  }
}

function setup() {
  FakeSocket.instances = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const conn = new Connection({
    url: "ws://test/ws",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    minDelay: 100,
    maxDelay: 1000,
    random: () => 1,
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: (() => {}) as typeof clearTimeout,
  });
  const states: ConnectionSnapshot["state"][] = [];
  conn.subscribe((s) => states.push(s.state));
  return { conn, states, timers, sockets: FakeSocket.instances };
}

const hello = {
  type: "hello",
  environmentId: "env_abcdefghij0123456789",
  version: "0.0.1",
  serverTime: "2026-10-02T00:00:00.000Z",
};

describe("Connection", () => {
  it("connects, learns the environment from hello, and exposes state", () => {
    const { conn, states, sockets } = setup();
    conn.connect();
    sockets[0]!.serverOpens();
    sockets[0]!.serverSends(hello);
    expect(conn.current.state).toBe("connected");
    expect(conn.current.environmentId).toBe(hello.environmentId);
    expect(conn.current.serverVersion).toBe("0.0.1");
    expect(states).toEqual(["closed", "connecting", "connected", "connected"]);
  });

  it("reconnects with growing backoff after the server drops", () => {
    const { conn, timers, sockets } = setup();
    conn.connect();
    sockets[0]!.serverOpens();
    sockets[0]!.serverDrops();
    expect(conn.current.state).toBe("reconnecting");
    expect(conn.current.attempt).toBe(1);
    expect(timers[0]!.ms).toBe(100);
    timers[0]!.fn();
    expect(sockets.length).toBe(2);
    sockets[1]!.serverDrops();
    expect(conn.current.attempt).toBe(2);
    expect(timers[1]!.ms).toBe(200);
    timers[1]!.fn();
    sockets[2]!.serverOpens();
    expect(conn.current.state).toBe("connected");
    expect(conn.current.attempt).toBe(0);
  });

  it("ignores frames that do not match the contract", () => {
    const { conn, sockets } = setup();
    const seen: unknown[] = [];
    conn.onFrame((f) => seen.push(f));
    conn.connect();
    sockets[0]!.serverOpens();
    sockets[0]!.serverSends({ type: "garbage" });
    sockets[0]!.onmessage?.({ data: "not json" });
    sockets[0]!.serverSends({ type: "pong", at: "now" });
    expect(seen).toEqual([{ type: "pong", at: "now" }]);
  });

  it("stops reconnecting once closed by the client", () => {
    const { conn, timers, sockets } = setup();
    conn.connect();
    sockets[0]!.serverOpens();
    conn.close();
    expect(conn.current.state).toBe("closed");
    expect(timers.length).toBe(0);
    expect(sockets.length).toBe(1);
  });
});
