import { describe, expect, it } from "vitest";
import { ClientFrame, Command, EnvironmentId, ProjectId, ServerFrame, ThreadId } from "./index.ts";

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
});
