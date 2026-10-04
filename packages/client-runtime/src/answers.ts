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
 * `suggestedDecision` on a permission request, Build it on a proposal. Null when some question
 * has no options, so there is nothing to send with one tap.
 */
export function suggestedAnswer(item: QueueItem): ItemAnswer | null {
  if (item.kind === "permission") return { kind: "permission", decision: suggestedDecision(item) };
  if (item.kind === "proposal") return { kind: "proposal", decision: "build" };
  const answers: Record<string, string> = {};
  for (const question of item.questions) {
    const option = suggestedOption(question.options);
    if (!option) return null;
    answers[question.id] = option.value;
  }
  return item.questions.length > 0 ? { kind: "question", answers } : null;
}
