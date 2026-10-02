import { describe, expect, it } from "vitest";
import { RuntimeEvent } from "./index.ts";

const base = {
  eventId: "evt_abcdefghij0123456789",
  threadId: "thr_abcdefghij0123456789",
  agent: "claude",
  createdAt: "2026-10-02T12:00:00.000Z",
};
const turnId = "11111111-1111-4111-8111-111111111111";
const requestId = "req_abcdefghij0123456789";

describe("RuntimeEvent", () => {
  it("parses a question with its options, ready for a card", () => {
    const event = RuntimeEvent.parse({
      ...base,
      turnId,
      requestId,
      type: "user-input.requested",
      payload: {
        itemId: "toolu_1",
        questions: [
          {
            id: "Which color?",
            header: "Color",
            question: "Which color?",
            options: [
              { label: "Red", value: "Red", description: "Warm", recommended: false },
              {
                label: "Blue",
                value: "Blue (Recommended)",
                description: "Cool",
                recommended: true,
                preview: "#00f",
              },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    expect(
      event.type === "user-input.requested" && event.payload.questions[0]?.options,
    ).toHaveLength(2);
  });

  it("requires the ids each kind of event is about", () => {
    const request = {
      ...base,
      type: "request.opened",
      payload: { toolKind: "command", toolName: "Bash", detail: "Bash: ls", input: {} },
    };
    expect(RuntimeEvent.safeParse(request).success).toBe(false); // no requestId
    expect(RuntimeEvent.safeParse({ ...request, requestId }).success).toBe(true);
    const turn = { ...base, type: "turn.started", payload: {} };
    expect(RuntimeEvent.safeParse(turn).success).toBe(false); // no turnId
    expect(RuntimeEvent.safeParse({ ...turn, turnId }).success).toBe(true);
    expect(RuntimeEvent.safeParse({ ...turn, turnId: "not-a-uuid" }).success).toBe(false);
    const item = {
      ...base,
      type: "item.completed",
      payload: { itemType: "tool", status: "completed" },
    };
    expect(RuntimeEvent.safeParse(item).success).toBe(false); // no itemId
    expect(RuntimeEvent.safeParse({ ...item, itemId: "toolu_1" }).success).toBe(true);
  });

  it("rejects unknown types, agents and decisions", () => {
    const error = { ...base, type: "runtime.error", payload: { message: "boom" } };
    expect(RuntimeEvent.safeParse(error).success).toBe(true);
    expect(RuntimeEvent.safeParse({ ...error, type: "runtime.oops" }).success).toBe(false);
    expect(RuntimeEvent.safeParse({ ...error, agent: "gemini" }).success).toBe(false);
    const resolved = {
      ...base,
      requestId,
      type: "request.resolved",
      payload: { decision: "maybe" },
    };
    expect(RuntimeEvent.safeParse(resolved).success).toBe(false);
  });
});
