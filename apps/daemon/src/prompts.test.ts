import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROPOSE, proposalOf, tenzoToolName } from "./agent/tenzo-mcp.ts";
import { APPROVED, cleanPrompt, loadThreadPrompts, promptFor, proposalReply } from "./prompts.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

describe("thread prompts", () => {
  it("are the plain files in apps/daemon/prompts, notes for editors dropped", () => {
    const prompts = loadThreadPrompts();
    for (const text of [prompts.discuss, prompts.build]) {
      expect(text).not.toContain("<!--");
      expect(text.length).toBeGreaterThan(100);
    }
    // What the flow depends on (PRODUCT.md §4).
    expect(prompts.discuss).toMatch(/Don't change anything until we agree/);
    expect(prompts.discuss).toMatch(/one question at a time/i);
    expect(prompts.discuss).toContain("AskUserQuestion");
    expect(prompts.discuss).toContain("`propose`");
    expect(prompts.discuss).toContain(APPROVED);
    expect(prompts.build).toMatch(/build it/i);
  });

  it("are read fresh from a directory, so an edit applies to the next session", () => {
    const dir = tempDir("prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "discuss.md"), "<!-- note -->\nTalk first.\n\n\n\nThen propose.\n");
    writeFileSync(join(dir, "build.md"), "Build.");
    expect(loadThreadPrompts(dir)).toEqual({ discuss: "Talk first.\n\nThen propose.", build: "Build." });
    writeFileSync(join(dir, "build.md"), "Build, carefully.");
    expect(loadThreadPrompts(dir).build).toBe("Build, carefully.");
  });

  it("pick the one for the thread's phase", () => {
    const prompts = { discuss: "D", build: "B" };
    expect(promptFor(prompts, "discussing")).toBe("D");
    expect(promptFor(prompts, "building")).toBe("B");
    expect(cleanPrompt("  a <!-- x\ny --> b  ")).toBe("a  b");
  });
});

describe("propose", () => {
  it("answers the agent: approved with the build prompt, or the note and propose again", () => {
    const prompts = { discuss: "D", build: "Build it here." };
    expect(proposalReply({ decision: "build" }, prompts)).toBe(
      "Approved, build it.\n\nBuild it here.",
    );
    expect(proposalReply({ decision: "build" }, undefined)).toBe("Approved, build it.");
    expect(proposalReply({ decision: "change", note: "Five rules." }, prompts)).toBe(
      "Not yet. Five rules.\n\nRevise, and propose again.",
    );
  });

  it("is Tenzo's server's tool, named as Claude names MCP tools", () => {
    expect(tenzoToolName(PROPOSE)).toBe("mcp__tenzo__propose");
  });

  it("shows the headline given, else the summary's first sentence, kept short", () => {
    expect(proposalOf({ summary: " Do it. ", headline: "  Add   a file " })).toEqual({
      headline: "Add a file",
      summary: "Do it.",
    });
    expect(proposalOf({ summary: "\n- Add CONTRIBUTING.md. Then check it.\nMore." }).headline).toBe(
      "Add CONTRIBUTING.md.",
    );
    expect(proposalOf({ summary: "x".repeat(200), headline: "" }).headline).toHaveLength(90);
  });
});
