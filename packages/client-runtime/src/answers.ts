import type { ItemAnswer, QueueItem } from "@tenzo/contracts";

/**
 * The answer the filled button sends: the agent's suggestion for every question, or the
 * suggested decision on a permission request. Null when some question has no suggestion, so
 * there is nothing to send with one tap.
 */
export function suggestedAnswer(item: QueueItem): ItemAnswer | null {
  if (item.kind === "permission") {
    if (item.suggested !== "allow" && item.suggested !== "deny") return null;
    return { kind: "permission", decision: item.suggested };
  }
  const answers: Record<string, string> = {};
  for (const question of item.questions) {
    const option = question.options.find((o) => o.recommended);
    if (!option) return null;
    answers[question.id] = option.value;
  }
  return item.questions.length > 0 ? { kind: "question", answers } : null;
}
