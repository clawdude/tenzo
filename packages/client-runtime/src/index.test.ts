import { describe, expect, it } from "vitest";
import { Connection, type ConnectionSnapshot } from "./index.ts";

/** A hand-driven WebSocket double: tests open, message and close it explicitly. */
class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  /** When set, the next constructions throw this (and consume one entry each). */
  static throwNext: unknown[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    if (FakeSocket.throwNext.length > 0) throw FakeSocket.throwNext.shift();
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

/** Fake timers with a working clearTimeout, so cancellation is observable. */
class FakeTimers {
  #next = 1;
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  /** Every delay ever scheduled, in order. */
  readonly delays: number[] = [];
  setTimeout = ((fn: () => void, ms: number) => {
    const id = this.#next++;
    this.pending.set(id, { fn, ms });
    this.delays.push(ms);
    return id;
  }) as unknown as typeof setTimeout;
  clearTimeout = ((id: number) => {
    this.pending.delete(id);
  }) as unknown as typeof clearTimeout;
  /** Runs the one pending timer, as if its delay elapsed. */
  fire() {
    expect(this.pending.size).toBe(1);
    const [id, timer] = [...this.pending][0]!;
    this.pending.delete(id);
    timer.fn();
  }
}

function setup({ random = () => 1 }: { random?: () => number } = {}) {
  FakeSocket.instances = [];
  FakeSocket.throwNext = [];
  const timers = new FakeTimers();
  const conn = new Connection({
    url: "ws://test/ws",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    minDelay: 100,
    maxDelay: 1000,
    random,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const states: ConnectionSnapshot["state"][] = [];
  conn.subscribe((s) => states.push(s.state));
  const sockets = FakeSocket.instances;
  const latest = () => sockets[sockets.length - 1]!;
  return { conn, states, timers, sockets, latest };
}

const hello = {
  type: "hello",
  environmentId: "env_abcdefghij0123456789",
  version: "0.0.1",
  serverTime: "2026-10-02T00:00:00.000Z",
};

describe("Connection", () => {
  it("is connected once the daemon says hello, and learns who it is", () => {
    const { conn, states, sockets } = setup();
    conn.connect();
    sockets[0]!.serverOpens();
    expect(conn.current.state).toBe("connecting");
    sockets[0]!.serverSends(hello);
    expect(conn.current.state).toBe("connected");
    expect(conn.current.environmentId).toBe(hello.environmentId);
    expect(conn.current.serverVersion).toBe("0.0.1");
    expect(states).toEqual(["closed", "connecting", "connected"]);
  });

  it("reconnects with growing backoff and resets it on hello", () => {
    const { conn, timers, latest } = setup();
    conn.connect();
    latest().serverDrops();
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 1 });
    timers.fire();
    latest().serverDrops();
    expect(conn.current.attempt).toBe(2);
    timers.fire();
    latest().serverOpens();
    latest().serverSends(hello);
    expect(conn.current).toMatchObject({ state: "connected", attempt: 0 });
    latest().serverDrops();
    expect(timers.delays).toEqual([100, 200, 100]);
  });

  it("keeps backing off when the server accepts and then drops before hello", () => {
    const { conn, timers, latest } = setup();
    conn.connect();
    for (let i = 0; i < 4; i++) {
      latest().serverOpens();
      latest().serverDrops();
      expect(conn.current.state).toBe("reconnecting");
      timers.fire();
    }
    expect(timers.delays).toEqual([100, 200, 400, 800]);
  });

  it("caps the backoff at maxDelay", () => {
    const { conn, timers, latest } = setup();
    conn.connect();
    for (let i = 0; i < 7; i++) {
      latest().serverDrops();
      timers.fire();
    }
    expect(timers.delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
  });

  it("jitters each delay down to half the step", () => {
    const { conn, timers, latest } = setup({ random: () => 0 });
    conn.connect();
    for (let i = 0; i < 6; i++) {
      latest().serverDrops();
      timers.fire();
    }
    expect(timers.delays).toEqual([50, 100, 200, 400, 500, 500]);
  });

  it("retries when the WebSocket constructor throws on connect", () => {
    const { conn, timers, sockets } = setup();
    FakeSocket.throwNext = [new DOMException("insecure", "SecurityError")];
    conn.connect();
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 1 });
    expect(timers.pending.size).toBe(1);
    timers.fire();
    expect(sockets.length).toBe(1);
    sockets[0]!.serverOpens();
    sockets[0]!.serverSends(hello);
    expect(conn.current.state).toBe("connected");
  });

  it("keeps retrying when the constructor throws during a reconnect", () => {
    const { conn, timers, sockets } = setup();
    conn.connect();
    FakeSocket.throwNext = [new SyntaxError("bad url"), new SyntaxError("bad url")];
    sockets[0]!.serverDrops();
    timers.fire();
    timers.fire();
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 3 });
    timers.fire();
    expect(sockets.length).toBe(2);
    expect(timers.delays).toEqual([100, 200, 400]);
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
    expect(conn.current.state).toBe("connecting");
  });

  it("stops for good when closed while connected", () => {
    const { conn, timers, sockets } = setup();
    conn.connect();
    sockets[0]!.serverOpens();
    sockets[0]!.serverSends(hello);
    conn.close();
    expect(conn.current.state).toBe("closed");
    expect(timers.pending.size).toBe(0);
    expect(sockets.length).toBe(1);
  });

  it("cancels a pending reconnect when closed during backoff", () => {
    const { conn, timers, sockets } = setup();
    conn.connect();
    sockets[0]!.serverDrops();
    expect(timers.pending.size).toBe(1);
    conn.close();
    expect(timers.pending.size).toBe(0);
    expect(conn.current).toMatchObject({ state: "closed", attempt: 0 });
    expect(sockets.length).toBe(1);
  });

  it("can connect again after close", () => {
    const { conn, sockets } = setup();
    conn.connect();
    conn.close();
    conn.connect();
    expect(sockets.length).toBe(2);
    sockets[1]!.serverOpens();
    sockets[1]!.serverSends(hello);
    expect(conn.current.state).toBe("connected");
  });

  it("sends frames only while the socket is open", () => {
    const { conn, sockets } = setup();
    conn.connect();
    expect(conn.send({ type: "ping", at: "a" })).toBe(false);
    sockets[0]!.serverOpens();
    expect(conn.send({ type: "ping", at: "b" })).toBe(true);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: "ping", at: "b" })]);
  });
});
