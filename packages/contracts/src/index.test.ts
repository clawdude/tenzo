import { describe, expect, it } from "vitest";
import {
  ClientFrame,
  Command,
  Device,
  EnvironmentId,
  liveOriginFor,
  liveUrl,
  MAX_EVENT_PAGE,
  ProjectId,
  PushSubscriptionInfo,
  ServerFrame,
  ThreadId,
} from "./index.ts";

describe("contracts", () => {
  it("accepts a well-formed environment id and rejects others", () => {
    expect(EnvironmentId.safeParse("env_abcdefghij0123456789").success).toBe(true);
    expect(EnvironmentId.safeParse("abc").success).toBe(false);
    expect(EnvironmentId.safeParse("env_ABC").success).toBe(false);
  });

  it("tells project and thread ids apart", () => {
    expect(ProjectId.safeParse("prj_abcdefghij0123456789").success).toBe(true);
    expect(ThreadId.safeParse("thr_abcdefghij0123456789").success).toBe(true);
    expect(ProjectId.safeParse("thr_abcdefghij0123456789").success).toBe(false);
    expect(ThreadId.safeParse("prj_abcdefghij0123456789").success).toBe(false);
  });

  it("parses server frames by type", () => {
    const hello = ServerFrame.parse({
      type: "hello",
      environmentId: "env_abcdefghij0123456789",
      version: "0.0.0",
      serverTime: "2026-10-02T00:00:00.000Z",
    });
    expect(hello.type).toBe("hello");
    expect(ServerFrame.safeParse({ type: "nope" }).success).toBe(false);
  });

  it("carries a watched thread's events, validated, and bounds a watch's backlog", () => {
    const event = {
      seq: 7,
      environmentId: "env_abcdefghij0123456789",
      event: {
        type: "thread.archived",
        eventId: "evt_abcdefghij0123456789",
        threadId: "thr_abcdefghij0123456789",
        agent: "claude",
        createdAt: "2026-10-02T00:00:00.000Z",
        payload: {},
      },
    };
    expect(ServerFrame.parse({ type: "event", event }).type).toBe("event");
    expect(ServerFrame.safeParse({ type: "event", event: { ...event, seq: 0 } }).success).toBe(false);
    const watch = { type: "thread.watch", threadId: "thr_x" };
    expect(Command.safeParse({ ...watch, after: 3, limit: MAX_EVENT_PAGE }).success).toBe(true);
    expect(Command.safeParse({ ...watch, limit: MAX_EVENT_PAGE + 1 }).success).toBe(false);
    expect(Command.safeParse({ type: "thread.events", threadId: "t", before: 0 }).success).toBe(false);
  });

  it("parses commands, and an answer's shape by its kind", () => {
    expect(Command.parse({ type: "snapshot" }).type).toBe("snapshot");
    const answer = {
      type: "item.answer",
      itemId: "itm_abcdefghij0123456789",
      answer: { kind: "permission", decision: "allow" },
    };
    expect(Command.safeParse(answer).success).toBe(true);
    expect(
      Command.safeParse({ ...answer, answer: { kind: "permission", decision: "maybe" } }).success,
    ).toBe(false);
    expect(
      Command.safeParse({ ...answer, answer: { kind: "question", answers: { q: "a" } } }).success,
    ).toBe(true);
    expect(Command.safeParse({ type: "thread.send", threadId: "thr_x", prompt: "" }).success).toBe(
      false,
    );
    expect(Command.safeParse({ type: "thread.delete" }).success).toBe(false);
  });

  it("takes a thread.create client key of 8 to 128 characters", () => {
    const create = { type: "thread.create", project: "app", prompt: "Hi" };
    const withKey = (clientKey: string) => Command.safeParse({ ...create, clientKey }).success;
    expect(Command.safeParse(create).success).toBe(true);
    expect(withKey("x".repeat(8))).toBe(true);
    expect(withKey("x".repeat(128))).toBe(true);
    expect(withKey("x".repeat(7))).toBe(false);
    expect(withKey("x".repeat(129))).toBe(false);
    expect(withKey("")).toBe(false);
  });

  it("parses client frames by type, a command's shape included", () => {
    expect(ClientFrame.parse({ type: "ping", at: "x" }).type).toBe("ping");
    const command = { type: "command", id: "1", command: { type: "snapshot" } };
    expect(ClientFrame.safeParse(command).success).toBe(true);
    expect(ClientFrame.safeParse({ ...command, id: "" }).success).toBe(false);
    expect(ClientFrame.safeParse({ ...command, id: "x".repeat(65) }).success).toBe(false);
    expect(ClientFrame.safeParse({ ...command, command: { type: "thread.delete" } }).success).toBe(
      false,
    );
  });

  it("parses command answers and change frames", () => {
    expect(ServerFrame.safeParse({ type: "ok", id: "1", result: { anything: true } }).success).toBe(
      true,
    );
    expect(ServerFrame.safeParse({ type: "error", id: null, error: "Not JSON." }).success).toBe(
      true,
    );
    expect(ServerFrame.safeParse({ type: "error", error: "no id" }).success).toBe(false);
    const snapshot = {
      type: "snapshot",
      snapshot: { environmentId: "env_abcdefghij0123456789", threads: [], items: [] },
    };
    expect(ServerFrame.safeParse(snapshot).success).toBe(true);
    expect(ServerFrame.safeParse({ ...snapshot, snapshot: { threads: [] } }).success).toBe(false);
    expect(ServerFrame.safeParse({ type: "item", change: "moved", item: {} }).success).toBe(false);
  });

  it("carries projects in the snapshot, and lists them on request", () => {
    expect(Command.parse({ type: "project.list" }).type).toBe("project.list");
    const project = {
      id: "prj_abcdefghij0123456789",
      environmentId: "env_abcdefghij0123456789",
      name: "app",
      defaultBranch: "main",
    };
    const frame = ServerFrame.parse({
      type: "snapshot",
      snapshot: { environmentId: project.environmentId, threads: [], items: [], projects: [project] },
    });
    expect(frame.type === "snapshot" && frame.snapshot.projects).toEqual([project]);
    // A snapshot from a daemon that sends no projects still reads, as none.
    const bare = ServerFrame.parse({
      type: "snapshot",
      snapshot: { environmentId: project.environmentId, threads: [], items: [] },
    });
    expect(bare.type === "snapshot" && bare.snapshot.projects).toEqual([]);
    expect(bare.type === "snapshot" && bare.snapshot.live).toBeNull();
  });

  it("links live apps to the live origin the browser can reach", () => {
    const live = { port: 4781, origins: ["https://mac.tail0000.ts.net:8444"] };
    const at = (protocol: string, hostname: string) => liveOriginFor({ protocol, hostname }, live);
    // Over the tailnet: the configured Serve route for that name.
    expect(at("https:", "mac.tail0000.ts.net")).toBe("https://mac.tail0000.ts.net:8444");
    expect(at("https:", "MAC.tail0000.ts.net")).toBe("https://mac.tail0000.ts.net:8444");
    // Locally: the live port on the name the Pass was reached by.
    expect(at("http:", "127.0.0.1")).toBe("http://127.0.0.1:4781");
    expect(at("http:", "localhost")).toBe("http://localhost:4781");
    expect(at("http:", "[::1]")).toBe("http://[::1]:4781");
    expect(liveOriginFor({ protocol: "http:", hostname: "x" }, null)).toBeNull();
    expect(liveUrl("http://127.0.0.1:4781", "thr_x", { path: "a?b" })).toBe(
      "http://127.0.0.1:4781/live/thr_x/a?b",
    );
  });

  it("takes a browser's push subscription only over https, keys well-formed", () => {
    const keys = { p256dh: `B${"a".repeat(86)}`, auth: "a".repeat(22) };
    const ok = (endpoint: string, k: object = keys) =>
      PushSubscriptionInfo.safeParse({ endpoint, expirationTime: null, keys: k }).success;
    expect(ok("https://fcm.googleapis.com/fcm/send/abc:def")).toBe(true);
    expect(ok("https://web.push.apple.com/QGlk")).toBe(true);
    expect(ok("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(ok("https://user:pw@push.example/x")).toBe(false);
    expect(ok("javascript:alert(1)")).toBe(false);
    expect(ok("https://push.example/x", { ...keys, auth: "short" })).toBe(false);
    expect(ok("https://push.example/x", { ...keys, p256dh: "not base64!" })).toBe(false);
  });

  it("carries whether a page is in view", () => {
    expect(ClientFrame.parse({ type: "visibility", visible: true })).toEqual({
      type: "visibility",
      visible: true,
    });
    expect(ClientFrame.safeParse({ type: "visibility" }).success).toBe(false);
  });

  it("gives a device from before notifications none", () => {
    const device = Device.parse({
      id: "dev_abcdefghij0123456789",
      name: "Phone",
      createdAt: "2026-10-05T00:00:00.000Z",
      lastSeenAt: null,
    });
    expect(device.push).toEqual({ subscribed: false, muted: false });
  });
});
