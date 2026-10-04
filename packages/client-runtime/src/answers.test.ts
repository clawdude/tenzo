import { describe, expect, it } from "vitest";
import { suggestedAnswer, suggestedDecision, suggestedOption } from "./answers.ts";
import { item } from "./testing.ts";

const question = (id: string, recommended: string | null, labels = ["A", "B"]) => ({
  id,
  header: "",
  question: id,
  options: labels.map((v) => ({
    label: v,
    value: `${v} (value)`,
    description: "",
    recommended: v === recommended,
  })),
  multiSelect: false,
});

describe("suggestedOption", () => {
  it("is the recommended option, else the first, else none", () => {
    expect(suggestedOption(question("q", "B").options)?.label).toBe("B");
    expect(suggestedOption(question("q", null).options)?.label).toBe("A");
    expect(suggestedOption([])).toBeNull();
  });
});

describe("suggestedAnswer", () => {
  it("answers every question with its recommended option's value", () => {
    const asked = item("x", "a", { questions: [question("One?", "B"), question("Two?", "A")] });
    expect(suggestedAnswer(asked)).toEqual({
      kind: "question",
      answers: { "One?": "B (value)", "Two?": "A (value)" },
    });
  });

  it("falls back to the first option where the agent recommends none", () => {
    const asked = item("x", "a", { questions: [question("One?", "B"), question("Two?", null)] });
    expect(suggestedAnswer(asked)).toEqual({
      kind: "question",
      answers: { "One?": "B (value)", "Two?": "A (value)" },
    });
  });

  it("has nothing to send when a question has no options, or there are no questions", () => {
    const bare = question("Two?", null, []);
    expect(suggestedAnswer(item("x", "a", { questions: [question("One?", "A"), bare] }))).toBeNull();
    expect(suggestedAnswer(item("x", "a", { questions: [] }))).toBeNull();
  });

  it("builds a proposal", () => {
    const proposal = item("x", "a", { kind: "proposal", suggested: "build", questions: [] });
    expect(suggestedAnswer(proposal)).toEqual({ kind: "proposal", decision: "build" });
  });

  it("never merges in one tap: finished work is Done, a ready PR has no one-tap answer", () => {
    const finished = item("x", "a", { kind: "finished", lane: "review", suggested: "merge", questions: [] });
    expect(suggestedAnswer(finished)).toEqual({ kind: "finished", decision: "done" });
    const ready = item("x", "a", { kind: "ready", suggested: "merge", questions: [] });
    expect(suggestedAnswer(ready)).toBeNull();
  });

  it("retries an error", () => {
    const error = item("x", "a", { kind: "error", suggested: "retry", questions: [] });
    expect(suggestedAnswer(error)).toEqual({ kind: "error", action: "retry" });
  });

  it("sends the suggested decision on a permission request, Allow when there is none", () => {
    const permission = item("x", "a", { kind: "permission", suggested: "allow" });
    expect(suggestedAnswer(permission)).toEqual({ kind: "permission", decision: "allow" });
    expect(suggestedAnswer({ ...permission, suggested: null })).toEqual({
      kind: "permission",
      decision: "allow",
    });
    expect(suggestedDecision({ ...permission, suggested: "deny" })).toBe("deny");
  });
});
