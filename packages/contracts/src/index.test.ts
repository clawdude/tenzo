import { describe, expect, it } from "vitest";
import {
  ClientFrame,
  Command,
  EnvironmentId,
  liveOriginFor,
  liveUrl,
  ProjectId,
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
});
