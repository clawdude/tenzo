import { describe, expect, it } from "vitest";
import { Connection, type ConnectionOptions, type ConnectionSnapshot } from "./connection.ts";
import { FakeClock, FakeSocket, hello } from "./testing.ts";

function setup(options: Partial<ConnectionOptions> = {}) {
  FakeSocket.reset();
  const clock = new FakeClock();
  const logged: string[] = [];
  let wake: (() => void) | null = null;
  const conn = new Connection({
    url: "ws://test/ws",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    minDelay: 100,
    maxDelay: 1000,
    stableAfter: 5000,
    helloTimeout: 2000,
    pingInterval: 1000,
    pongTimeout: 500,
    probeTimeout: 200,
    random: () => 1,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    wakeups: (fn) => {
      wake = fn;
      return () => {
        wake = null;
      };
    },
    log: (message) => logged.push(message),
    ...options,
  });
  const states: ConnectionSnapshot["state"][] = [];
  conn.subscribe((s) => states.push(s.state));
  const sockets = FakeSocket.instances;
  const latest = () => sockets[sockets.length - 1]!;
  /** The pending retry's delay, after a drop (the only timer left then). */
  const retryDelay = () => {
    expect(clock.waiting).toHaveLength(1);
    return clock.waiting[0]!;
  };
  /** Waits out the pending retry: a new socket opens. */
  const retry = () => clock.advance(retryDelay());
  const connected = () => {
    latest().serverOpens();
    latest().serverSends(hello);
  };
  return {
    conn,
    states,
    clock,
    sockets,
    latest,
    retryDelay,
    retry,
    connected,
    logged,
    wake: () => wake?.(),
    wakeSubscribed: () => wake !== null,
  };
}

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

  it("keeps backing off when the server accepts and then drops before hello", () => {
    const { conn, latest, retryDelay, retry } = setup();
    conn.connect();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      latest().serverOpens();
      latest().serverDrops();
      expect(conn.current.state).toBe("reconnecting");
      delays.push(retryDelay());
      retry();
    }
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it("caps the backoff at maxDelay", () => {
    const { conn, latest, retryDelay, retry } = setup();
    conn.connect();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      latest().serverDrops();
      delays.push(retryDelay());
      retry();
    }
    expect(delays).toEqual([100, 200, 400, 800, 1000, 1000, 1000]);
  });

  it("jitters each delay down to half the step", () => {
    const { conn, latest, retryDelay, retry } = setup({ random: () => 0 });
    conn.connect();
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      latest().serverDrops();
      delays.push(retryDelay());
      retry();
    }
    expect(delays).toEqual([50, 100, 200, 400, 500, 500]);
  });

  it("keeps the backoff when a daemon says hello and drops at once", () => {
    const { conn, latest, retryDelay, retry, connected } = setup();
    conn.connect();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      connected();
      expect(conn.current.state).toBe("connected");
      latest().serverDrops();
      delays.push(retryDelay());
      retry();
    }
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it("resets the backoff once a connection has been up for a stable period", () => {
    const { conn, clock, latest, retryDelay, retry, connected } = setup({ pingInterval: 60_000 });
    conn.connect();
    latest().serverDrops();
    retry();
    latest().serverDrops();
    retry();
    connected();
    expect(conn.current.attempt).toBe(2);
    clock.advance(4999);
    expect(conn.current.attempt).toBe(2);
    clock.advance(1);
    expect(conn.current).toMatchObject({ state: "connected", attempt: 0 });
    latest().serverDrops();
    expect(retryDelay()).toBe(100);
  });

  it("gives up on an attempt that gets no hello in time", () => {
    const { conn, clock, sockets, retry } = setup();
    conn.connect();
    sockets[0]!.serverOpens(); // a socket, but no daemon behind it
    clock.advance(1999);
    expect(conn.current.state).toBe("connecting");
    clock.advance(1);
    expect(sockets[0]!.closed).toBe(true);
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 1 });
    retry();
    // A socket that never even opens (a SYN into the void) times out the same way.
    clock.advance(2000);
    expect(sockets[1]!.closed).toBe(true);
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 2 });
  });

  it("pings a quiet connection and drops it when the ping goes unanswered", () => {
    const { conn, clock, sockets, connected } = setup();
    conn.connect();
    connected();
    const socket = sockets[0]!;
    clock.advance(1000);
    expect(socket.frames.map((f) => f.type)).toEqual(["ping"]);
    socket.serverSends({ type: "pong", at: "x" });
    clock.advance(1000);
    expect(socket.frames.map((f) => f.type)).toEqual(["ping", "ping"]);
    clock.advance(499);
    expect(conn.current.state).toBe("connected");
    clock.advance(1); // no pong: the connection is dead even though no close ever came
    expect(socket.closed).toBe(true);
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 1 });
  });

  it("counts any frame as an answer to a ping", () => {
    const { conn, clock, sockets, connected } = setup();
    conn.connect();
    connected();
    clock.advance(1000);
    sockets[0]!.serverSends({ type: "error", id: null, error: "whatever" });
    clock.advance(1400);
    expect(conn.current.state).toBe("connected");
  });

  it("retries at once on a wakeup while waiting out a backoff", () => {
    const { conn, latest, sockets, retry, wake } = setup({ minDelay: 10_000, maxDelay: 60_000 });
    conn.connect();
    latest().serverDrops();
    retry();
    latest().serverDrops();
    expect(sockets).toHaveLength(2);
    wake(); // the page came back to the foreground
    expect(sockets).toHaveLength(3);
    latest().serverOpens();
    latest().serverSends(hello);
    expect(conn.current.state).toBe("connected");
  });

  it("probes a connection on a wakeup and replaces it at once if it doesn't answer", () => {
    const { conn, clock, sockets, latest, connected, wake } = setup({ pingInterval: 60_000 });
    conn.connect();
    connected();
    wake();
    expect(sockets[0]!.frames.map((f) => f.type)).toEqual(["ping"]);
    sockets[0]!.serverSends({ type: "pong", at: "x" });
    clock.advance(1000);
    expect(conn.current.state).toBe("connected"); // healthy: kept

    wake(); // a phone that slept: the socket looks open but nothing comes back
    clock.advance(200);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets).toHaveLength(2); // no backoff wait: the person is looking
    expect(conn.current.state).toBe("reconnecting");
    latest().serverOpens();
    latest().serverSends(hello);
    expect(conn.current.state).toBe("connected");
  });

  it("leaves an attempt in progress alone on a wakeup", () => {
    const { conn, sockets, wake } = setup();
    conn.connect();
    wake();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.sent).toEqual([]);
  });

  it("listens for wakeups only while it wants a connection", () => {
    const { conn, wakeSubscribed } = setup();
    expect(wakeSubscribed()).toBe(false);
    conn.connect();
    expect(wakeSubscribed()).toBe(true);
    conn.close();
    expect(wakeSubscribed()).toBe(false);
  });

  it("retries when the WebSocket constructor throws on connect", () => {
    const { conn, sockets, retry, connected } = setup();
    FakeSocket.throwNext = [new DOMException("insecure", "SecurityError")];
    conn.connect();
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 1 });
    retry();
    expect(sockets.length).toBe(1);
    connected();
    expect(conn.current.state).toBe("connected");
  });

  it("keeps retrying when the constructor throws during a reconnect", () => {
    const { conn, sockets, retryDelay, retry } = setup();
    conn.connect();
    FakeSocket.throwNext = [new SyntaxError("bad url"), new SyntaxError("bad url")];
    sockets[0]!.serverDrops();
    const delays = [retryDelay()];
    retry();
    delays.push(retryDelay());
    retry();
    expect(conn.current).toMatchObject({ state: "reconnecting", attempt: 3 });
    delays.push(retryDelay());
    retry();
    expect(sockets.length).toBe(2);
    expect(delays).toEqual([100, 200, 400]);
  });

  it("ignores and logs frames that do not match the contract", () => {
    const { conn, sockets, logged } = setup();
    const seen: unknown[] = [];
    conn.onFrame((f) => seen.push(f));
    conn.connect();
    sockets[0]!.serverOpens();
    sockets[0]!.serverSends({ type: "garbage" });
    sockets[0]!.serverSends({ ...hello, environmentId: "nope" });
    sockets[0]!.onmessage?.({ data: "not json" });
    sockets[0]!.onmessage?.({ data: new ArrayBuffer(4) });
    sockets[0]!.serverSends({ type: "pong", at: "now" });
    expect(seen).toEqual([{ type: "pong", at: "now" }]);
    expect(logged).toHaveLength(4);
    expect(conn.current.state).toBe("connecting");
  });

  it("keeps going when a listener throws", () => {
    const { conn, sockets, logged } = setup();
    const states: string[] = [];
    const frames: string[] = [];
    conn.subscribe(() => {
      throw new Error("view bug");
    });
    conn.subscribe((s) => states.push(s.state));
    conn.onFrame(() => {
      throw new Error("frame bug");
    });
    conn.onFrame((f) => frames.push(f.type));
    conn.connect();
    sockets[0]!.serverOpens();
    expect(() => sockets[0]!.serverSends(hello)).not.toThrow();
    expect(conn.current.state).toBe("connected");
    expect(states).toEqual(["closed", "connecting", "connected"]);
    expect(frames).toEqual(["hello"]);
    expect(() => sockets[0]!.serverDrops()).not.toThrow();
    expect(conn.current.state).toBe("reconnecting");
    expect(logged.filter((m) => m === "a listener threw").length).toBeGreaterThanOrEqual(4);
  });

  it("stops for good when closed while connected", () => {
    const { conn, clock, sockets, connected } = setup();
    conn.connect();
    connected();
    conn.close();
    expect(conn.current.state).toBe("closed");
    expect(clock.pending.size).toBe(0);
    expect(sockets[0]!.closed).toBe(true);
    expect(sockets.length).toBe(1);
  });

  it("cancels a pending reconnect when closed during backoff", () => {
    const { conn, clock, sockets } = setup();
    conn.connect();
    sockets[0]!.serverDrops();
    expect(clock.pending.size).toBe(1);
    conn.close();
    expect(clock.pending.size).toBe(0);
    expect(conn.current).toMatchObject({ state: "closed", attempt: 0 });
    expect(sockets.length).toBe(1);
  });

  it("can connect again after close", () => {
    const { conn, sockets, connected } = setup();
    conn.connect();
    conn.close();
    conn.connect();
    expect(sockets.length).toBe(2);
    connected();
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
