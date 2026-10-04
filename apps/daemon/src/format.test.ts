import type { QueueItem, ThreadId } from "@tenzo/contracts";
import { describe, expect, it } from "vitest";
import { answerFromWords } from "./answers.ts";
import { formatEvent, formatItem } from "./format.ts";

const THREAD = "thr_abcdefghij0123456789" as ThreadId;

describe("formatEvent", () => {
  it("prints one readable line per event", () => {
    const base = {
      eventId: "evt_abcdefghij0123456789",
      threadId: THREAD,
      agent: "claude" as const,
      createdAt: "2026-10-02T00:00:00.000Z",
    };
    expect(
      formatEvent({
        ...base,
        type: "turn.completed",
        turnId: "11111111-1111-4111-8111-111111111111",
        payload: { state: "completed", costUsd: 0.01234, durationMs: 5700 },
      }),
    ).toBe("turn.completed       completed · $0.0123 · 5.7s");
    expect(
      formatEvent({
        ...base,
        type: "item.completed",
        itemId: "toolu_1",
        payload: {
          itemType: "tool",
          status: "failed",
          text: "Bash: make",
          parentItemId: "toolu_a",
        },
      }),
    ).toBe("item.completed         ↳ ✗ Bash: make");
    expect(
      formatEvent({
        ...base,
        type: "request.resolved",
        requestId: "req_abcdefghij0123456789",
        payload: { decision: "deny", message: "no" },
      }),
    ).toBe("request.resolved     deny: no");
  });
});

describe("formatItem", () => {
  const item: QueueItem = {
    id: "itm_abcdefghij0123456789",
    environmentId: "env_abcdefghij0123456789",
    threadId: THREAD,
    lane: "quick",
    kind: "question",
    requestId: "req_abcdefghij0123456789",
    context: "I read the repo.",
    ask: "Which color?",
    options: [],
    suggested: "Blue (Recommended)",
    questions: [
      {
        id: "Which color?",
        header: "Color",
        question: "Which color?",
        options: [
          { label: "Red", value: "Red", description: "Warm", recommended: false },
          { label: "Blue", value: "Blue (Recommended)", description: "", recommended: true },
        ],
        multiSelect: false,
      },
    ],
    createdAt: "2026-10-02T00:00:00.000Z",
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
  };

  it("shows the context, the question and numbered options with the suggestion", () => {
    expect(formatItem(item, "Paint it")).toBe(
      [
        "itm_abcdefghij0123456789 · Paint it · question",
        "  I read the repo.",
        "  ? Which color?  [Color]",
        "    1. Red — Warm",
        "    2. Blue (suggested)",
      ].join("\n"),
    );
  });

  it("shows a proposal: headline, summary, Build it or what to change", () => {
    const proposal: QueueItem = {
      ...item,
      kind: "proposal",
      ask: "Add CONTRIBUTING.md",
      suggested: "build",
      questions: [],
      proposal: { headline: "Add CONTRIBUTING.md", summary: "Three rules.\n\nCheck: it renders." },
    };
    expect(formatItem(proposal, "Contributing")).toBe(
      [
        "itm_abcdefghij0123456789 · Contributing · proposal",
        "  I read the repo.",
        "  ! Add CONTRIBUTING.md",
        "    Three rules.",
        "    Check: it renders.",
        "    1. Build it (suggested)",
        "    Or say what to change.",
      ].join("\n"),
    );
  });

  it("shows finished work: headline, note, checks, screenshots, live app, Done", () => {
    const finished: QueueItem = {
      ...item,
      lane: "review",
      kind: "finished",
      context: "",
      ask: "Counter works",
      suggested: "done",
      questions: [],
      finished: {
        headline: "Counter works",
        summary: "Added a counter.",
        howToTest: "Tap it.",
        checks: [
          { name: "Tests", status: "pass" },
          { name: "Lint", status: "fail" },
        ],
        attachments: [
          {
            id: "att_aaaaaaaaaaaaaaaaaaaa",
            file: "att_aaaaaaaaaaaaaaaaaaaa.png",
            name: "a.png",
            mediaType: "image/png",
            bytes: 1,
          },
        ],
        live: { port: 5173, path: "" },
      },
    };
    expect(formatItem(finished, "Counter")).toBe(
      [
        "itm_abcdefghij0123456789 · Counter · finished",
        "  ✓ Counter works",
        "    Added a counter.",
        "    Checks: Tests pass, Lint fail",
        "    Screenshots: 1",
        "    Live: port 5173",
        "    1. Done (suggested)",
      ].join("\n"),
    );
    expect(answerFromWords(finished, ["done"])).toEqual({ kind: "finished", decision: "done" });
    expect(() => answerFromWords(finished, ["merge"])).toThrow(/with done/);
  });

  it("says when answering resumes a stopped agent", () => {
    expect(formatItem({ ...item, detached: true })).toMatch(/answering resumes it/);
  });
});
