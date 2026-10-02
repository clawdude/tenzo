import { describe, expect, it } from "vitest";
import { ClientFrame, EnvironmentId, ProjectId, ServerFrame, ThreadId } from "./index.ts";

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

  it("parses client frames by type", () => {
    expect(ClientFrame.parse({ type: "ping", at: "x" }).type).toBe("ping");
  });
});
