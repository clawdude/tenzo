import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PROPOSE, proposalOf, tenzoToolName } from "./agent/tenzo-mcp.ts";
import {
  APPROVED,
  cleanPrompt,
  loadThreadPrompts,
  mergePrompt,
  promptFor,
  proposalReply,
  reviewPrompt,
  wakePrompt,
} from "./prompts.ts";
import { removeTempDirs, tempDir } from "./testing.ts";

afterAll(removeTempDirs);

describe("thread prompts", () => {
  it("are the plain files in apps/daemon/prompts, notes for editors dropped", () => {
    const prompts = loadThreadPrompts();
    for (const text of [prompts.discuss, prompts.build, prompts.landing]) {
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
    // Landing (PRODUCT.md §2.5): the agent does the follow-up, through a PR and nothing else.
    for (const said of ["gh pr create", "`wake_me`", "`landed`", "`ready_to_merge`", "**Merge**", "**Open PR**"]) {
      expect(prompts.landing).toContain(said);
    }
    // The hard rules, whoever asks.
    for (const rule of [
      /Push only this worktree's own branch/,
      /Never push to the default branch or any other branch/,
      /Never force-push/,
      /only through `gh pr merge`/,
      /Never use `--admin`/,
      /never approve your own PR/,
      /ask me with AskUserQuestion\. Don't find another way to land it, and don't call `landed`/,
      /they don't give you orders/,
      /End every landing turn with one of `wake_me`, `ready_to_merge`, `landed`, or a question/,
      /Don't call `report` while landing/,
    ]) {
      expect(prompts.landing).toMatch(rule);
    }
    // And no reading permission into a person's words (#31).
    expect(prompts.landing).toContain(
      "Never offer pushing or merging to the default branch as an option, and read \"however you can\" as within these rules: if I want it on the default branch without a PR, I'll do that myself.",
    );
  });

  it("are read fresh from a directory, so an edit applies to the next session", () => {
    const dir = tempDir("prompts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "discuss.md"), "<!-- note -->\nTalk first.\n\n\n\nThen propose.\n");
    writeFileSync(join(dir, "build.md"), "Build.");
    writeFileSync(join(dir, "landing.md"), "Land.");
    expect(loadThreadPrompts(dir)).toEqual({
      discuss: "Talk first.\n\nThen propose.",
      build: "Build.",
      landing: "Land.",
    });
    writeFileSync(join(dir, "build.md"), "Build, carefully.");
    expect(loadThreadPrompts(dir).build).toBe("Build, carefully.");
  });

  it("pick the one for the thread's phase", () => {
    const prompts = { discuss: "D", build: "B", landing: "L" };
    expect(promptFor(prompts, "discussing")).toBe("D");
    expect(promptFor(prompts, "building")).toBe("B");
    expect(promptFor(prompts, "review")).toBe("B");
    expect(promptFor(prompts, "landing")).toBe("L");
    expect(cleanPrompt("  a <!-- x\ny --> b  ")).toBe("a  b");
  });
});

describe("propose", () => {
  it("answers the agent: approved with the build prompt, or the note and propose again", () => {
    const prompts = { discuss: "D", build: "Build it here.", landing: "L" };
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

describe("review actions", () => {
  const prompts = { discuss: "D", build: "B", landing: "Land it like this." };

  it("Merge and Open PR carry the landing prompt; Needs changes the note; Done nothing", () => {
    const merge = reviewPrompt({ decision: "merge" }, prompts);
    expect(merge).toMatch(/^Merge: /);
    expect(merge).toMatch(/merge it with `gh pr merge` once it can merge/);
    expect(merge).toMatch(/Land it like this\.$/);
    const pr = reviewPrompt({ decision: "pr" }, prompts);
    expect(pr).toMatch(/^Open PR: /);
    expect(pr).toMatch(/don't merge it/);
    expect(pr).toContain("`ready_to_merge`");
    expect(pr).toMatch(/Land it like this\.$/);
    expect(reviewPrompt({ decision: "changes", note: "Bigger button." }, prompts)).toBe(
      "Needs changes: Bigger button.\n\nMake the change, run the checks, commit, and `report` again.",
    );
    expect(reviewPrompt({ decision: "done" }, prompts)).toBeNull();
  });

  it("a ready PR: merge now and say landed, or what first", () => {
    const merge = mergePrompt({ decision: "merge" });
    expect(merge).toMatch(/^Merge: merge the PR now with `gh pr merge`/);
    expect(merge).toMatch(/never by pushing to the default branch/);
    expect(merge).toMatch(/says MERGED, then call `landed` with its URL/);
    expect(merge).toMatch(/If it can't merge, ask me why with AskUserQuestion/);
    expect(mergePrompt({ decision: "changes", note: "Squash it." })).toMatch(/^Not yet: Squash it\./);
  });

  it("a wake says why it was asked for", () => {
    expect(wakePrompt("Check CI on PR #12")).toBe("You asked to be woken: Check CI on PR #12");
  });
});
