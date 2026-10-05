import { describe, expect, it } from "vitest";
import { isSnoozed } from "./index.ts";
import { applyFrame, EMPTY } from "./state.ts";
import { automation, item, project, snapshotFrame, thread } from "./testing.ts";

describe("applyFrame", () => {
  it("replaces everything with a snapshot", () => {
    const before = {
      ...EMPTY,
      threads: [thread("a")],
      items: [item("x", "a")],
      projects: [project("app")],
      automations: [automation("old")],
    };
    const live = { port: 4781, origins: ["https://mac.ts.net:8444"] };
    const after = applyFrame(before, snapshotFrame([thread("b")], [], [project("blog")], live));
    expect(after).toEqual({
      threads: [thread("b")],
      items: [],
      projects: [project("blog")],
      live,
      automations: [],
      automationsPaused: false,
      automationProblems: [],
    });
  });

  it("keeps the automations: from the snapshot, then each automations frame replaces them whole", () => {
    const frame = snapshotFrame([thread("a")], []);
    let data = applyFrame(EMPTY, {
      ...frame,
      snapshot: { ...frame.snapshot, automations: [automation("nightly"), automation("weekly")] },
    });
    expect(data.automations.map((a) => a.name)).toEqual(["nightly", "weekly"]);
    const threads = data.threads;
    const problem = { projectId: automation("x").projectId, projectName: "blog", problem: "bad JSON" };
    data = applyFrame(data, {
      type: "automations",
      automations: [automation("nightly", { nextRunAt: "2026-10-02T01:00:00.000Z" })],
      paused: true,
      problems: [problem],
    });
    expect(data.automations).toEqual([automation("nightly", { nextRunAt: "2026-10-02T01:00:00.000Z" })]);
    expect(data.automationsPaused).toBe(true);
    expect(data.automationProblems).toEqual([problem]);
    // Threads and items are untouched.
    expect(data.threads).toBe(threads);
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

  it("keeps a snoozed item, with its return time, until the daemon wakes it; the daemon decides", () => {
    // A time long past by any clock: still snoozed until the daemon says otherwise.
    const until = "2000-01-01T00:00:00.000Z";
    let data = applyFrame(EMPTY, snapshotFrame([thread("a")], [item("x", "a")]));
    data = applyFrame(data, {
      type: "item",
      change: "snoozed",
      item: item("x", "a", { snoozedUntil: until }),
    });
    const [snoozed] = data.items;
    expect(snoozed?.snoozedUntil).toBe(until);
    expect(isSnoozed(snoozed ?? item("x", "a"))).toBe(true);
    data = applyFrame(data, { type: "item", change: "unsnoozed", item: item("x", "a") });
    expect(data.items[0]?.snoozedUntil).toBeNull();
    expect(isSnoozed(data.items[0] ?? item("x", "a", { snoozedUntil: until }))).toBe(false);
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
