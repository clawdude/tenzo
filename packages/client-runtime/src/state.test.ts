import { describe, expect, it } from "vitest";
import { applyFrame, EMPTY } from "./state.ts";
import { item, snapshotFrame, thread } from "./testing.ts";

describe("applyFrame", () => {
  it("replaces everything with a snapshot", () => {
    const before = { threads: [thread("a")], items: [item("x", "a")] };
    const after = applyFrame(before, snapshotFrame([thread("b")], []));
    expect(after).toEqual({ threads: [thread("b")], items: [] });
  });

  it("adds a new thread at the end and updates a known one in place", () => {
    let data = applyFrame(EMPTY, snapshotFrame([thread("a"), thread("b")], []));
    data = applyFrame(data, { type: "thread", thread: thread("c") });
    data = applyFrame(data, { type: "thread", thread: thread("a", { title: "Renamed" }) });
    expect(data.threads.map((t) => t.title)).toEqual(["Renamed", "Thread b", "Thread c"]);
  });

  it("drops a thread once it is archived", () => {
    let data = applyFrame(EMPTY, snapshotFrame([thread("a"), thread("b")], []));
    data = applyFrame(data, { type: "thread", thread: thread("a", { status: "archived" }) });
    expect(data.threads.map((t) => t.id)).toEqual([thread("b").id]);
    // An archived thread it never knew stays out.
    expect(applyFrame(data, { type: "thread", thread: thread("z", { status: "archived" }) })).toBe(
      data,
    );
  });

  it("opens, updates and resolves items, and a repeat changes nothing", () => {
    let data = applyFrame(EMPTY, snapshotFrame([thread("a")], []));
    const opened = { type: "item", change: "opened", item: item("x", "a") } as const;
    data = applyFrame(data, opened);
    data = applyFrame(data, opened);
    data = applyFrame(data, { type: "item", change: "opened", item: item("y", "a") });
    expect(data.items.map((i) => i.id)).toEqual([item("x", "a").id, item("y", "a").id]);
    data = applyFrame(data, {
      type: "item",
      change: "detached",
      item: item("x", "a", { detached: true }),
    });
    expect(data.items[0]?.detached).toBe(true);
    data = applyFrame(data, {
      type: "item",
      change: "resolved",
      item: item("x", "a", { status: "resolved", resolution: { kind: "allowed" } }),
    });
    expect(data.items.map((i) => i.id)).toEqual([item("y", "a").id]);
  });

  it("ignores frames that carry no data", () => {
    const data = applyFrame(EMPTY, snapshotFrame([thread("a")], []));
    expect(applyFrame(data, { type: "pong", at: "x" })).toBe(data);
    expect(applyFrame(data, { type: "ok", id: "1", result: {} })).toBe(data);
  });
});
