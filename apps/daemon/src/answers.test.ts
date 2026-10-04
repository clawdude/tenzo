import type { QueueItem, RuntimeEventOf, UserInputQuestion } from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import { boundedInput } from "./agent/claude-events.ts";
import { fingerprintOf } from "./agent/fingerprint.ts";
import {
  answerFromWords,
  checkAnswer,
  deliveryPrompt,
  matchReply,
  standingReply,
} from "./answers.ts";

const color: UserInputQuestion = {
  id: "Which color?",
  header: "Color",
  question: "Which color?",
  options: [
    { label: "Red", value: "Red", description: "Warm", recommended: false },
    { label: "Blue", value: "Blue (Recommended)", description: "Cool", recommended: true },
  ],
  multiSelect: false,
};
const size: UserInputQuestion = {
  id: "Which size?",
  header: "",
  question: "Which size?",
  options: [],
  multiSelect: false,
};

const base = {
  id: "itm_abcdefghij0123456789",
  environmentId: "env_abcdefghij0123456789",
  threadId: "thr_abcdefghij0123456789",
  lane: "quick",
  requestId: "req_abcdefghij0123456789",
  context: "",
  createdAt: "2026-10-02T00:00:00.000Z",
  status: "open",
  detached: true,
  resolvedAt: null,
  resolution: null,
} as const;

const question = (questions: UserInputQuestion[] = [color]): QueueItem => ({
  ...base,
  kind: "question",
  ask: questions[0]?.question ?? "",
  options: questions[0]?.options ?? [],
  suggested: null,
  questions,
});
const permission: QueueItem = {
  ...base,
  kind: "permission",
  ask: "Allow Bash: rm -rf build?",
  options: [],
  suggested: "allow",
  questions: [],
  permission: {
    toolKind: "command",
    toolName: "Bash",
    detail: "Bash: rm -rf build",
    input: { command: "rm -rf build" },
  },
  fingerprint: fingerprintOf("Bash", { command: "rm -rf build" }),
};

describe("answerFromWords", () => {
  it("picks an option by number or label, or takes free text", () => {
    const q = question();
    expect(answerFromWords(q, ["2"])).toEqual({
      kind: "question",
      answers: { "Which color?": "Blue (Recommended)" },
    });
    expect(answerFromWords(q, ["blue"])).toEqual({
      kind: "question",
      answers: { "Which color?": "Blue (Recommended)" },
    });
    expect(answerFromWords(q, ["Green,", "please"])).toEqual({
      kind: "question",
      answers: { "Which color?": "Green, please" },
    });
    expect(() => answerFromWords(q, ["7"])).toThrow(/isn't one of the 2 options/);
    expect(() => answerFromWords(q, ["1,2"])).toThrow(/isn't one of/);
  });

  it("joins picks for a multi-select question", () => {
    const q = question([{ ...color, multiSelect: true }]);
    expect(answerFromWords(q, ["1,", "2"])).toEqual({
      kind: "question",
      answers: { "Which color?": "Red, Blue (Recommended)" },
    });
  });

  it("takes one argument per question when there are several", () => {
    const q = question([color, size]);
    expect(answerFromWords(q, ["1", "large please"])).toEqual({
      kind: "question",
      answers: { "Which color?": "Red", "Which size?": "large please" },
    });
    expect(() => answerFromWords(q, ["1"])).toThrow(/asks 2 questions/);
  });

  it("reads allow, deny, or a reason to deny for a permission request", () => {
    for (const yes of ["allow", "y", "1", "YES"]) {
      expect(answerFromWords(permission, [yes])).toEqual({ kind: "permission", decision: "allow" });
    }
    for (const no of ["deny", "n", "2"]) {
      expect(answerFromWords(permission, [no])).toEqual({ kind: "permission", decision: "deny" });
    }
    expect(answerFromWords(permission, ["use", "git", "clean"])).toEqual({
      kind: "permission",
      decision: "deny",
      message: "use git clean",
    });
  });
});

const proposal: QueueItem = {
  ...base,
  kind: "proposal",
  ask: "Add CONTRIBUTING.md",
  options: [{ label: "Build it", value: "build", description: "", recommended: true }],
  suggested: "build",
  questions: [],
  proposal: { headline: "Add CONTRIBUTING.md", summary: "Three rules." },
  fingerprint: fingerprintOf("mcp__tenzo__propose", { summary: "Three rules." }),
};

describe("answering a proposal", () => {
  it("reads build, or anything else as what to change", () => {
    for (const yes of ["build", "Build it", "y", "1"]) {
      expect(answerFromWords(proposal, yes.split(" "))).toEqual({
        kind: "proposal",
        decision: "build",
      });
    }
    expect(answerFromWords(proposal, ["five", "rules"])).toEqual({
      kind: "proposal",
      decision: "change",
      note: "five rules",
    });
    expect(() => answerFromWords(proposal, [])).toThrow(/build, or say what to change/);
  });

  it("wants a note to change something, and drops one sent with Build it", () => {
    expect(checkAnswer(proposal, { kind: "proposal", decision: "build", note: "x" })).toEqual({
      kind: "proposal",
      decision: "build",
    });
    expect(
      checkAnswer(proposal, { kind: "proposal", decision: "change", note: " Five rules " }),
    ).toEqual({ kind: "proposal", decision: "change", note: "Five rules" });
    expect(() => checkAnswer(proposal, { kind: "proposal", decision: "change", note: " " })).toThrow(
      "Say what to change.",
    );
    expect(() => checkAnswer(proposal, { kind: "permission", decision: "allow" })).toThrow(
      /is a proposal; answer it with build, or what to change/,
    );
    expect(() => checkAnswer(permission, { kind: "proposal", decision: "build" })).toThrow(
      /permission request/,
    );
  });

  it("tells a resumed agent the decision", () => {
    expect(deliveryPrompt(proposal, { kind: "proposal", decision: "build" })).toBe(
      "Your session ended while you were waiting for my answer to your proposal: Add CONTRIBUTING.md\nApproved, build it. Carry on from where you left off.",
    );
    expect(
      deliveryPrompt(proposal, { kind: "proposal", decision: "change", note: "Five rules" }),
    ).toMatch(/proposal: Add CONTRIBUTING.md\nNot yet. Five rules\nRevise, and propose again.$/);
  });

  it("answers the same proposal again for you, and nothing else", () => {
    const reply = standingReply(proposal, { kind: "proposal", decision: "build" });
    expect(reply).toEqual({ kind: "proposal", fingerprint: proposal.fingerprint, decision: "build" });
    const proposedAgain = (fingerprint: string) =>
      ({
        eventId: "evt_abcdefghij0123456789",
        threadId: base.threadId,
        agent: "claude",
        createdAt: base.createdAt,
        type: "proposal.requested",
        requestId: "req_zzzzzzzzzzzzzzzzzzzz",
        payload: { headline: "Add CONTRIBUTING.md", summary: "Three rules.", fingerprint },
      }) as const;
    const replies = reply ? [reply] : [];
    expect(matchReply(replies, proposedAgain(proposal.fingerprint ?? ""))).toBe(0);
    expect(matchReply(replies, proposedAgain(fingerprintOf("mcp__tenzo__propose", {})))).toBe(-1);
  });
});

describe("checkAnswer", () => {
  it("wants an answer of the item's kind, for every question, trimmed", () => {
    expect(() => checkAnswer(permission, { kind: "question", answers: {} })).toThrow(
      /permission request; answer it with allow or deny/,
    );
    expect(() =>
      checkAnswer(question([color, size]), { kind: "question", answers: { "Which color?": "Red" } }),
    ).toThrow(/"Which size\?" needs an answer/);
    expect(
      checkAnswer(question(), {
        kind: "question",
        answers: { "Which color?": " Red ", stray: "x" },
      }),
    ).toEqual({ kind: "question", answers: { "Which color?": "Red" } });
    expect(
      checkAnswer(permission, { kind: "permission", decision: "deny", message: "  " }),
    ).toEqual({ kind: "permission", decision: "deny" });
  });

  it("takes Merge, Open PR or Done on finished work, and wants a note for Needs changes", () => {
    const finished = { ...permission, kind: "finished" as const, permission: undefined };
    expect(checkAnswer(finished, { kind: "finished", decision: "merge", note: "x" })).toEqual({
      kind: "finished",
      decision: "merge",
    });
    expect(checkAnswer(finished, { kind: "finished", decision: "pr" })).toEqual({
      kind: "finished",
      decision: "pr",
    });
    expect(() => checkAnswer(finished, { kind: "finished", decision: "changes", note: " " })).toThrow(
      /what needs changing/,
    );
    expect(checkAnswer(finished, { kind: "finished", decision: "changes", note: " Bigger " })).toEqual({
      kind: "finished",
      decision: "changes",
      note: "Bigger",
    });
    expect(standingReply(finished, { kind: "finished", decision: "merge" })).toBeNull();
  });

  it("takes Merge on a ready PR, or what to do first", () => {
    const ready = {
      ...permission,
      kind: "ready" as const,
      permission: undefined,
      ready: { url: "https://github.com/o/r/pull/1", summary: "Green." },
    };
    expect(checkAnswer(ready, { kind: "ready", decision: "merge" })).toEqual({
      kind: "ready",
      decision: "merge",
    });
    expect(() => checkAnswer(ready, { kind: "ready", decision: "changes" })).toThrow(/before merging/);
    expect(() => checkAnswer(ready, { kind: "finished", decision: "merge" })).toThrow(
      /a PR ready to merge; answer it with merge, or what to do first/,
    );
    expect(standingReply(ready, { kind: "ready", decision: "merge" })).toBeNull();
  });
});

describe("delivering an answer to a resumed agent", () => {
  it("says what was asked and what was chosen, by label", () => {
    const text = deliveryPrompt(question([color, size]), {
      kind: "question",
      answers: { "Which color?": "Blue (Recommended)", "Which size?": "large" },
    });
    expect(text).toBe(
      [
        "Your session ended while you were waiting for my answer, so here it is.",
        "",
        "You asked: Which color?",
        "My answer: Blue",
        "",
        "You asked: Which size?",
        "My answer: large",
        "",
        "Carry on from where you left off.",
      ].join("\n"),
    );
  });

  it("tells it whether it may go ahead", () => {
    expect(deliveryPrompt(permission, { kind: "permission", decision: "allow" })).toBe(
      "Your session ended while you were waiting for my permission for this: Bash: rm -rf build\nI allow it. Go ahead, and carry on from where you left off.",
    );
    expect(
      deliveryPrompt(permission, { kind: "permission", decision: "deny", message: "use git clean" }),
    ).toMatch(/I don't allow it: use git clean\nDon't do it/);
  });

  it("recognizes the same ask only by its fingerprint, and only of the same kind", () => {
    const reply = standingReply(permission, { kind: "permission", decision: "allow" });
    expect(reply).toMatchObject({ fingerprint: permission.fingerprint, decision: "allow" });
    const again = (fingerprint?: string) =>
      ({
        eventId: "evt_abcdefghij0123456789",
        threadId: base.threadId,
        agent: "claude",
        createdAt: base.createdAt,
        type: "request.opened",
        requestId: "req_zzzzzzzzzzzzzzzzzzzz",
        payload: {
          toolKind: "command",
          toolName: "Bash",
          detail: "Bash: rm -rf build",
          input: { command: "rm -rf build" }, // the same shown input every time
          ...(fingerprint ? { fingerprint } : {}),
        },
      }) as const;
    const replies = reply ? [reply] : [];
    expect(matchReply(replies, again(permission.fingerprint))).toBe(0);
    expect(matchReply(replies, again(fingerprintOf("Bash", { command: "rm -rf /" })))).toBe(-1);
    expect(matchReply(replies, again())).toBe(-1); // no fingerprint: never answered for you
    const { payload: _, ...head } = again(permission.fingerprint);
    const asked: RuntimeEventOf<"user-input.requested"> = {
      ...head,
      type: "user-input.requested",
      payload: { questions: [], ...(permission.fingerprint ? { fingerprint: permission.fingerprint } : {}) },
    };
    expect(matchReply(replies, asked)).toBe(-1);
  });

  it("gives no standing reply for an item without a fingerprint", () => {
    const { fingerprint: _, ...bare } = permission;
    expect(standingReply(bare, { kind: "permission", decision: "allow" })).toBeNull();
  });
});

describe("fingerprints", () => {
  it("differ for inputs that differ only beyond everything an event keeps", () => {
    const long = "x".repeat(2100);
    const safe = { command: `${long} && echo ok!`, description: "build" };
    const evil = { command: `${long} && rm -rf ~`, description: "build" };
    // Equal as shown (cut to 2000 characters, the same length)...
    expect(boundedInput(safe)).toEqual(boundedInput(evil));
    // ...but not as asked.
    expect(fingerprintOf("Bash", safe)).not.toBe(fingerprintOf("Bash", evil));

    const write = (tail: string) => ({ file_path: "/home/me/.zshrc", content: `${"#".repeat(300)}${tail}` });
    expect(boundedInput(write("safe"))).toEqual(boundedInput(write("evil")));
    expect(fingerprintOf("Write", write("safe"))).not.toBe(fingerprintOf("Write", write("evil")));

    const keys = (last: string) =>
      Object.fromEntries([...Array.from({ length: 20 }, (_, i) => [`k${i}`, 1]), ["z", last]]);
    expect(boundedInput(keys("a"))).toEqual(boundedInput(keys("b")));
    expect(fingerprintOf("T", keys("a"))).not.toBe(fingerprintOf("T", keys("b")));
  });

  it("ignore key order and include the tool name", () => {
    expect(fingerprintOf("T", { a: 1, b: { c: 2, d: 3 } })).toBe(
      fingerprintOf("T", { b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(fingerprintOf("Read", { x: 1 })).not.toBe(fingerprintOf("Write", { x: 1 }));
    expect(fingerprintOf("T", {})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
