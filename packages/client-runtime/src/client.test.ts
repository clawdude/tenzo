import { describe, expect, it } from "vitest";
import { CommandError, TenzoClient, type TenzoState } from "./client.ts";
import { FakeClock, FakeSocket, hello, item, snapshotFrame, thread } from "./testing.ts";

function setup() {
  FakeSocket.reset();
  const clock = new FakeClock();
  const logged: string[] = [];
  const client = new TenzoClient({
    url: "ws://test/ws",
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    minDelay: 100,
    random: () => 1,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    wakeups: null,
    log: (message) => logged.push(message),
  });
  const seen: TenzoState[] = [];
  client.subscribe((s) => seen.push(s));
  const sockets = FakeSocket.instances;
  const latest = () => sockets[sockets.length - 1]!;
  /** Connects the latest socket and sends it a snapshot. */
  const synced = (frame = snapshotFrame([thread("a")], [item("x", "a")])) => {
    latest().serverOpens();
    latest().serverSends(hello);
    latest().serverSends(frame);
  };
  /** The last command frame the client sent. */
  const lastCommand = () => {
    const frame = latest().frames.filter((f) => f.type === "command").at(-1);
    if (!frame) throw new Error("no command sent");
    return frame as { type: "command"; id: string; command: { type: string } };
  };
  return { client, clock, seen, sockets, latest, synced, lastCommand, logged };
}

const answer = {
  type: "item.answer",
  itemId: item("x", "a").id,
  answer: { kind: "question", answers: { "Which color?": "Red" } },
} as const;

describe("TenzoClient", () => {
  it("starts empty and fills from the snapshot sent on connect", () => {
    const { client, synced } = setup();
    expect(client.state).toMatchObject({ threads: [], items: [], synced: false });
    client.connect();
    synced();
    expect(client.state.connection.state).toBe("connected");
    expect(client.state.synced).toBe(true);
    expect(client.state.threads).toEqual([thread("a")]);
    expect(client.state.items).toEqual([item("x", "a")]);
  });

  it("applies thread and item changes as they stream in", () => {
    const { client, latest, synced, seen } = setup();
    client.connect();
    synced();
    const before = seen.length;
    latest().serverSends({ type: "thread", thread: thread("b") });
    latest().serverSends({ type: "item", change: "opened", item: item("y", "b") });
    latest().serverSends({
      type: "item",
      change: "resolved",
      item: item("x", "a", { status: "resolved", resolution: { kind: "cancelled" } }),
    });
    expect(client.state.threads.map((t) => t.id)).toEqual([thread("a").id, thread("b").id]);
    expect(client.state.items.map((i) => i.id)).toEqual([item("y", "b").id]);
    expect(seen.length).toBe(before + 3);
  });

  it("sends a command with an id and resolves with its validated result", async () => {
    const { client, latest, synced, lastCommand } = setup();
    client.connect();
    synced();
    const result = client.command(answer);
    const sent = lastCommand();
    expect(sent.command).toEqual(answer);
    const resolved = item("x", "a", {
      status: "resolved",
      resolution: { kind: "answered", answers: { "Which color?": "Red" } },
    });
    // The change arrives before the answer, so the state is current when the promise resolves.
    latest().serverSends({ type: "item", change: "resolved", item: resolved });
    latest().serverSends({
      type: "ok",
      id: sent.id,
      result: { item: resolved, delivery: "live", thread: thread("a") },
    });
    await expect(result).resolves.toMatchObject({ delivery: "live", item: { status: "resolved" } });
    expect(client.state.items).toEqual([]);
  });

  it("matches answers to commands by id, in any order", async () => {
    const { client, latest, synced, lastCommand } = setup();
    client.connect();
    synced();
    const first = client.command({ type: "thread.list" });
    const firstId = lastCommand().id;
    const second = client.command({ type: "thread.send", threadId: "thr_nope", prompt: "hi" });
    const secondId = lastCommand().id;
    expect(firstId).not.toBe(secondId);
    latest().serverSends({ type: "error", id: secondId, error: 'No thread "thr_nope".' });
    latest().serverSends({ type: "ok", id: firstId, result: { threads: [] } });
    await expect(first).resolves.toEqual({ threads: [] });
    const error = await second.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect(error).toMatchObject({ reason: "rejected", message: 'No thread "thr_nope".' });
  });

  it("rejects an answer that doesn't match the contract", async () => {
    const { client, latest, synced, lastCommand } = setup();
    client.connect();
    synced();
    const result = client.command({ type: "thread.list" });
    latest().serverSends({ type: "ok", id: lastCommand().id, result: { threads: "nope" } });
    await expect(result).rejects.toMatchObject({ reason: "invalid" });
  });

  it("refuses commands at once while not connected, sending nothing", async () => {
    const { client, sockets, latest } = setup();
    await expect(client.command({ type: "thread.list" })).rejects.toMatchObject({
      reason: "offline",
    });
    client.connect();
    latest().serverOpens(); // a socket, but no hello yet
    await expect(client.command({ type: "thread.list" })).rejects.toMatchObject({
      reason: "offline",
    });
    expect(sockets[0]!.sent).toEqual([]);
  });

  it("fails commands in flight when the connection drops, and ignores late answers", async () => {
    const { client, latest, synced, lastCommand, clock } = setup();
    client.connect();
    synced();
    const result = client.command(answer);
    const id = lastCommand().id;
    const old = latest();
    old.serverDrops();
    await expect(result).rejects.toMatchObject({ reason: "lost" });
    clock.advance(100);
    synced();
    old.onmessage?.({ data: JSON.stringify({ type: "ok", id, result: {} }) }); // detached: ignored
    expect(client.state.synced).toBe(true);
  });

  it("keeps the last data while reconnecting, then replaces it with the new snapshot", () => {
    const { client, latest, synced, clock } = setup();
    client.connect();
    synced();
    latest().serverDrops();
    expect(client.state.connection.state).toBe("reconnecting");
    expect(client.state.synced).toBe(false);
    expect(client.state.items).toHaveLength(1); // last known, for showing while away
    clock.advance(100);
    latest().serverOpens();
    latest().serverSends(hello);
    expect(client.state).toMatchObject({ synced: false });
    // Meanwhile the item was answered elsewhere and a thread started.
    latest().serverSends(snapshotFrame([thread("a"), thread("b")], []));
    expect(client.state.synced).toBe(true);
    expect(client.state.items).toEqual([]);
    expect(client.state.threads.map((t) => t.id)).toEqual([thread("a").id, thread("b").id]);
  });

  it("leaves the state alone on frames that don't match the contract", () => {
    const { client, latest, synced, logged } = setup();
    client.connect();
    synced();
    const before = client.state;
    latest().serverSends({ type: "item", change: "opened", item: { id: "itm_bad" } });
    latest().serverSends({ type: "snapshot", snapshot: { threads: [] } });
    latest().onmessage?.({ data: "{" });
    expect(client.state).toBe(before);
    expect(logged).toHaveLength(3);
  });

  it("reports errors the daemon can't tie to a command", () => {
    const { client, latest, synced, logged } = setup();
    client.connect();
    synced();
    latest().serverSends({ type: "error", id: null, error: "Not a frame" });
    expect(logged).toContain("the daemon reported an error");
  });

  it("keeps notifying the other views when one listener throws", () => {
    const { client, latest, synced, seen, logged } = setup();
    client.subscribe(() => {
      throw new Error("view bug");
    });
    client.connect();
    expect(() => synced()).not.toThrow();
    expect(seen.at(-1)?.synced).toBe(true);
    expect(() =>
      latest().serverSends({ type: "item", change: "opened", item: item("y", "a") }),
    ).not.toThrow();
    expect(seen.at(-1)?.items).toHaveLength(2);
    expect(logged).toContain("a listener threw");
  });
});
