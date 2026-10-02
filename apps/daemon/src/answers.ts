import type {
  Fingerprint,
  ItemAnswer,
  QueueItem,
  RuntimeEventOf,
  UserInputAnswers,
  UserInputQuestion,
} from "@tenzo/contracts";
import { TenzoError } from "./errors.ts";

/**
 * Answers to items: checking them, and delivering one to an agent that is no longer waiting.
 *
 * When the agent process that asked has ended (it crashed, or the daemon restarted), there is no
 * pending request to answer. Tenzo then resumes the agent's session and sends the answer as a
 * message saying what was asked and what you chose (`deliveryPrompt`). The agent usually just
 * carries on; if it asks exactly the same thing again in that turn (it re-runs the tool, which
 * asks for permission again), the daemon answers it with your answer instead of asking you twice
 * (`StandingReply`). "Exactly" means the same fingerprint of the full request; anything else is
 * asked again.
 */

/** An answer waiting for the agent to ask again, matched by `fingerprint`. */
export type StandingReply =
  | { kind: "question"; fingerprint: Fingerprint; answers: UserInputAnswers }
  | { kind: "permission"; fingerprint: Fingerprint; decision: "allow" | "deny"; message?: string };

/** The answer, tidied, if it fits the item; else a TenzoError saying what is wrong. */
export function checkAnswer(item: QueueItem, answer: ItemAnswer): ItemAnswer {
  if (answer.kind !== item.kind) {
    throw new TenzoError(
      `${item.id} is a ${item.kind === "question" ? "question" : "permission request"}; answer it with ${item.kind === "question" ? "an answer to each question" : "allow or deny"}.`,
    );
  }
  if (answer.kind === "permission") {
    const message = answer.message?.trim();
    return { kind: "permission", decision: answer.decision, ...(message ? { message } : {}) };
  }
  const answers: UserInputAnswers = {};
  for (const q of item.questions) {
    const value = answer.answers[q.id]?.trim();
    if (!value) throw new TenzoError(`"${q.question || q.id}" needs an answer.`);
    answers[q.id] = value;
  }
  return { kind: "question", answers };
}

/**
 * The answer to give if the agent asks exactly this again, or null when the item carries no
 * fingerprint: then nothing is ever answered for you. Matching is on the adapter's fingerprint
 * of the full request (agent/fingerprint.ts), never on the cut-down copy items show, which two
 * different requests can share.
 */
export function standingReply(item: QueueItem, answer: ItemAnswer): StandingReply | null {
  const fingerprint = item.fingerprint;
  if (!fingerprint) return null;
  return answer.kind === "question"
    ? { kind: "question", fingerprint, answers: answer.answers }
    : {
        kind: "permission",
        fingerprint,
        decision: answer.decision,
        ...(answer.message ? { message: answer.message } : {}),
      };
}

/** The standing reply for this request, if one matches it exactly and is of its kind. */
export function matchReply(
  replies: readonly StandingReply[],
  event: RuntimeEventOf<"user-input.requested"> | RuntimeEventOf<"request.opened">,
): number {
  const fingerprint = event.payload.fingerprint;
  if (!fingerprint) return -1;
  const kind = event.type === "user-input.requested" ? "question" : "permission";
  return replies.findIndex((r) => r.kind === kind && r.fingerprint === fingerprint);
}

/** The message that tells a resumed agent what it asked before it stopped, and the answer. */
export function deliveryPrompt(item: QueueItem, answer: ItemAnswer): string {
  if (answer.kind === "question") {
    const lines = item.questions.flatMap((q) => [
      `You asked: ${q.question || q.header}`,
      `My answer: ${labelOf(q, answer.answers[q.id] ?? "")}`,
      "",
    ]);
    return [
      "Your session ended while you were waiting for my answer, so here it is.",
      "",
      ...lines,
      "Carry on from where you left off.",
    ].join("\n");
  }
  const what = item.permission?.detail ?? item.ask;
  const head = `Your session ended while you were waiting for my permission for this: ${what}`;
  return answer.decision === "allow"
    ? `${head}\nI allow it. Go ahead, and carry on from where you left off.`
    : `${head}\nI don't allow it${answer.message ? `: ${answer.message}` : "."}\nDon't do it; carry on from where you left off without it.`;
}

/** An option's label for its value ("Blue (Recommended)" → "Blue"); free text as it is. */
function labelOf(q: UserInputQuestion, value: string): string {
  const labels = value.split(", ").map((v) => q.options.find((o) => o.value === v)?.label);
  return labels.every((l) => l !== undefined) ? labels.join(", ") : value;
}

/**
 * What the words after `tenzo answer <item>` mean. A question: a number picks an option, so
 * does its label; anything else is your own answer. Several questions take one argument each.
 * A permission request: `allow`/`y`/`1`, `deny`/`n`/`2`, or anything else to deny with that as
 * the reason.
 */
export function answerFromWords(item: QueueItem, words: readonly string[]): ItemAnswer {
  if (item.kind === "permission") {
    const text = words.join(" ").trim();
    if (/^(1|y|yes|allow)$/i.test(text)) return { kind: "permission", decision: "allow" };
    if (text === "" || /^(2|n|no|deny)$/i.test(text)) {
      return { kind: "permission", decision: "deny" };
    }
    return { kind: "permission", decision: "deny", message: text };
  }
  const questions = item.questions;
  const replies = questions.length === 1 ? [words.join(" ")] : [...words];
  if (replies.length !== questions.length) {
    throw new TenzoError(
      `${item.id} asks ${questions.length} questions: give one answer for each, quoting answers with spaces.`,
    );
  }
  const answers: UserInputAnswers = {};
  questions.forEach((q, i) => {
    const reply = (replies[i] ?? "").trim();
    const picked = pick(q, reply);
    if (picked === undefined) {
      throw new TenzoError(
        reply === ""
          ? `"${q.question}" needs an answer.`
          : `"${reply}" isn't one of the ${q.options.length} options for "${q.question}".`,
      );
    }
    answers[q.id] = picked;
  });
  return { kind: "question", answers };
}

/** The answer a reply stands for; undefined when it's empty or picks an option that isn't there. */
export function pick(q: UserInputQuestion, reply: string): string | undefined {
  if (reply === "") return undefined;
  const byLabel = q.options.find((o) => o.label.toLowerCase() === reply.toLowerCase());
  if (byLabel) return byLabel.value;
  const numbers = reply.split(/\s*,\s*/);
  if (q.options.length === 0 || !numbers.every((n) => /^\d+$/.test(n))) return reply; // free text
  if (!q.multiSelect && numbers.length > 1) return undefined;
  const values = numbers.map((n) => q.options[Number(n) - 1]?.value);
  return values.every((v) => v !== undefined) ? values.join(", ") : undefined;
}
