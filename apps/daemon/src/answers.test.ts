import type { QueueItem, UserInputQuestion } from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import {
  answerFromWords,
  checkAnswer,
  deliveryPrompt,
  itemFingerprint,
  requestFingerprint,
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

  it("recognizes the same ask when the resumed agent repeats it", () => {
    const reply = standingReply(permission, { kind: "permission", decision: "allow" });
    const again = {
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
        input: { command: "rm -rf build" },
      },
    } as const;
    expect(requestFingerprint(again)).toBe(reply.fingerprint);
    expect(
      requestFingerprint({ ...again, payload: { ...again.payload, input: { command: "rm -rf /" } } }),
    ).not.toBe(reply.fingerprint);
    expect(itemFingerprint(question())).not.toBe(itemFingerprint(permission));
  });
});
