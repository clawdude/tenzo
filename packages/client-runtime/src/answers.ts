import type { ItemAnswer, QueueItem, UserInputOption } from "@tenzo/contracts";

/**
 * The option for the filled button: the one the agent recommends, else the first. Claude marks
 * a recommendation only sometimes, and the card always offers one tap. Null without options.
 */
export function suggestedOption<T extends Pick<UserInputOption, "recommended">>(
  options: readonly T[],
): T | null {
  return options.find((o) => o.recommended) ?? options[0] ?? null;
}

/**
 * The decision the filled button sends on a permission request: the item's suggestion when it
 * has one, else Allow, as in Claude Code's own prompt.
 */
export function suggestedDecision(item: QueueItem): "allow" | "deny" {
  return item.suggested === "deny" ? "deny" : "allow";
}

/**
 * The answer that taking every suggestion sends: each question's `suggestedOption`, the
 * `suggestedDecision` on a permission request, Build it on a proposal, Done on finished work,
 * Retry on an error. Null when some question has no options, so there is nothing to send with
 * one tap, and on a ready PR. Merge is the filled button on finished work and a ready PR, but
 * never what one tap on everything sends: landing is a decision of its own.
 */
export function suggestedAnswer(item: QueueItem): ItemAnswer | null {
  if (item.kind === "permission") return { kind: "permission", decision: suggestedDecision(item) };
  if (item.kind === "proposal") return { kind: "proposal", decision: "build" };
  if (item.kind === "finished") return { kind: "finished", decision: "done" };
  if (item.kind === "error") return { kind: "error", action: "retry" };
  if (item.kind === "ready") return null;
  const answers: Record<string, string> = {};
  for (const question of item.questions) {
    const option = suggestedOption(question.options);
    if (!option) return null;
    answers[question.id] = option.value;
  }
  return item.questions.length > 0 ? { kind: "question", answers } : null;
}
